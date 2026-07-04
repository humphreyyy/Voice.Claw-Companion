#!/usr/bin/env node
import { readFileSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const runtimePath = join(root, 'BridgeRuntime', 'server', 'index.js');
const source = readFileSync(runtimePath, 'utf8');

const expectedIphoneTools = [
  'iphone_analyze_clipboard_image',
  'iphone_analyze_selected_media',
  'iphone_cancel_voice_route_switch',
  'iphone_capture_photo_for_analysis',
  'iphone_clear_transcript',
  'iphone_confirm_voice_engine_switch',
  'iphone_confirm_voice_route_switch',
  'iphone_copy_text',
  'iphone_create_calendar_event',
  'iphone_create_reminder',
  'iphone_current_location',
  'iphone_draft_email',
  'iphone_draft_message',
  'iphone_end_voice_session',
  'iphone_list_calendar_events',
  'iphone_list_reminders',
  'iphone_lookup_contact',
  'iphone_open_app_settings',
  'iphone_open_maps',
  'iphone_open_url',
  'iphone_open_voiceclaw_tab',
  'iphone_open_whatsapp',
  'iphone_prepare_voice_route_switch',
  'iphone_read_clipboard',
  'iphone_restart_voice_session',
  'iphone_run_shortcut',
  'iphone_search_web',
  'iphone_set_microphone_muted',
  'iphone_set_speakerphone_enabled',
  'iphone_set_transcript_visible',
  'iphone_share',
  'iphone_start_phone_call',
  'iphone_status',
  'iphone_sync_watch_settings',
];

function fail(message) {
  console.error(`Runtime contract check failed: ${message}`);
  process.exitCode = 1;
}

function extractIphoneTools() {
  const marker = 'const IPHONE_REALTIME_TOOLS = [';
  const start = source.indexOf(marker);
  if (start === -1) {
    fail('missing IPHONE_REALTIME_TOOLS');
    return [];
  }
  const tail = source.slice(start);
  const endMatch = tail.match(/\n\];\n\nconst /);
  if (!endMatch) {
    fail('could not find end of IPHONE_REALTIME_TOOLS');
    return [];
  }
  const section = tail.slice(0, endMatch.index);
  return [...new Set([...section.matchAll(/name:\s*['"](iphone_[^'"]+)['"]/g)].map((match) => match[1]))].sort();
}

const actualIphoneTools = extractIphoneTools();
const expected = [...expectedIphoneTools].sort();
const missing = expected.filter((name) => !actualIphoneTools.includes(name));
const extra = actualIphoneTools.filter((name) => !expected.includes(name));
if (missing.length) fail(`missing iPhone tools: ${missing.join(', ')}`);
if (extra.length) fail(`unexpected iPhone tools: ${extra.join(', ')}`);

const stalePhrases = [
  'DO NOT send substantive questions to OpenClaw by default',
  'Call openclaw_turn only when',
  'only when the user explicitly asks for OpenClaw',
  'wait for explicit OpenClaw',
  'iphone_switch_voice_route',
  'ask one short confirmation question',
  'ask whether to switch and restart',
  'no direct Realtime/MCP tool can handle',
  'with GPT-5.5 Instant vision',
  'iPhone waits briefly so the user can say stop to cancel',
  'VoiceClaw waits briefly so the user can say stop to cancel',
  'they can say stop to cancel',
  'short stop-to-cancel window',
  'short cancellation window',
  'microphone mute/unmute',
  'mute/unmute',
  'unmute my mic',
  'Your mic is muted',
];

for (const phrase of stalePhrases) {
  if (source.includes(phrase)) fail(`stale phrase still present: ${phrase}`);
}

const requiredPhrases = [
  'OpenClaw is not a fallback, not escalation-only, and not only for computer/file/coding work',
  'If the user did not say "OpenClaw," still call openclaw_turn for substantive work',
  'iphone_set_transcript_visible opens or closes the transcript panel',
  'iphone_set_speakerphone_enabled switches only the live VoiceClaw audio output',
  "iphone_confirm_voice_route_switch changes VoiceClaw's selected route",
  "iphone_confirm_voice_engine_switch changes VoiceClaw's selected voice engine",
  'There is no stop-to-cancel window',
  'through the active VoiceClaw route when possible',
  'Do not use it for voice unmute requests',
  'say exactly: "Mic Muted"',
];

for (const phrase of requiredPhrases) {
  if (!source.includes(phrase)) fail(`required contract phrase missing: ${phrase}`);
}

if (!process.exitCode) {
  console.log(`Runtime contract check passed (${actualIphoneTools.length} iPhone tools).`);
}
