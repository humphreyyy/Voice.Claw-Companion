import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const source = readFileSync(join(here, '..', 'server', 'index.js'), 'utf8');

function extractTemplate(name) {
  const declaration = `const ${name} =`;
  const start = source.indexOf(declaration);
  if (start === -1) throw new Error(`Missing ${name}`);
  const templateStart = source.indexOf('`', start);
  const templateEnd = source.indexOf('`;', templateStart + 1);
  if (templateStart === -1 || templateEnd === -1) throw new Error(`Missing template body for ${name}`);
  return source.slice(templateStart + 1, templateEnd);
}

function assertContains(name, text, needle) {
  if (!text.includes(needle)) {
    throw new Error(`${name} is missing required prompt text: ${needle}`);
  }
}

function assertOmits(name, text, needle) {
  if (text.includes(needle)) {
    throw new Error(`${name} mentions unavailable tool name: ${needle}`);
  }
}

function extractArray(name) {
  const declaration = `const ${name} = [`;
  const start = source.indexOf(declaration);
  if (start === -1) throw new Error(`Missing ${name}`);
  const end = source.indexOf('];', start + declaration.length);
  if (end === -1) throw new Error(`Missing array end for ${name}`);
  return source.slice(start, end + 2);
}

function toolNamesFromArray(name) {
  return [...extractArray(name).matchAll(/name: '([a-z0-9_]+)'/g)].map((match) => match[1]);
}

const openClaw = extractTemplate('REALTIME_INSTRUCTIONS');
const direct = extractTemplate('REALTIME_DIRECT_INSTRUCTIONS');
const instant = extractTemplate('REALTIME_INSTANT_INSTRUCTIONS');
const iphoneSummary = extractTemplate('IPHONE_TOOL_CAPABILITY_SUMMARY');
const capabilityAwareness = extractTemplate('CAPABILITY_AWARENESS_INSTRUCTIONS');
const openClawTools = toolNamesFromArray('REALTIME_TOOLS');
const instantTools = toolNamesFromArray('INSTANT_REALTIME_TOOLS');
const iphoneTools = toolNamesFromArray('IPHONE_REALTIME_TOOLS');

function expandedPrompt(text) {
  return text
    .replaceAll('${CAPABILITY_AWARENESS_INSTRUCTIONS}', capabilityAwareness)
    .replaceAll('${IPHONE_TOOL_CAPABILITY_SUMMARY}', iphoneSummary);
}

const expandedOpenClaw = expandedPrompt(openClaw);
const expandedDirect = expandedPrompt(direct);
const expandedInstant = expandedPrompt(instant);

for (const needle of [
  'Operating loop',
  'Examples and routing patterns',
  'Capability boundaries and routing priority',
  'GPT-Realtime-2 is a full first responder',
  'DO NOT send substantive questions to OpenClaw by default',
  'Direct GPT-Realtime-2 is the live conversation layer',
  'iPhone-side tools are the device-action layer',
  'Active work controls are part of the OpenClaw route',
  'Apple Watch settings sync',
  'Apple Watch can use Direct GPT-Realtime-2',
  'Direct GPT-5.5 Instant over cellular',
  'Tool precision and confirmation',
  'calendar/reminder reading or creation',
  'Calendar and reminder reads expose private iPhone data',
  'selected media analysis',
  'camera photo analysis',
  'clipboard image analysis',
  'WhatsApp handoffs',
  'choose Notes in the share sheet',
  'iOS system shortcuts',
  'get VoiceClaw status',
  'User-extensible iPhone automation through Shortcuts',
  'When explaining capabilities',
  'named Apple Shortcuts',
  'custom iPhone workflows',
  'Do not repeatedly call the same failed tool',
  'keep normal GPT-Realtime-2 conversation and iPhone-side actions available',
  'wait_for_user',
  'Do not respond conversationally after wait_for_user',
  'steer_openclaw instead of starting a second OpenClaw turn',
  'bridge_status before starting another OpenClaw turn',
]) {
  assertContains('REALTIME_INSTRUCTIONS', openClaw, needle);
}

for (const needle of [
  'Capability awareness as VoiceClaw grows',
  'The active route and active tool list are authoritative',
  'Do not under-use GPT-Realtime-2',
  'Use iphone_status when the user asks about this iPhone',
  'Permission-gated tools such as Location, Contacts, Calendar, Reminders, microphone, camera, and clipboard access',
  'Use bridge_status when the user asks about OpenClaw queue',
]) {
  assertContains('CAPABILITY_AWARENESS_INSTRUCTIONS', capabilityAwareness, needle);
}

for (const [name, text] of [
  ['REALTIME_INSTRUCTIONS', openClaw],
  ['REALTIME_DIRECT_INSTRUCTIONS', direct],
  ['REALTIME_INSTANT_INSTRUCTIONS', instant],
]) {
  assertContains(name, text, '${CAPABILITY_AWARENESS_INSTRUCTIONS}');
}

for (const needle of ['openclaw_turn', 'steer_openclaw', 'stop_openclaw', 'bridge_status']) {
  assertOmits('REALTIME_DIRECT_INSTRUCTIONS', direct, needle);
  assertOmits('REALTIME_INSTANT_INSTRUCTIONS', instant, needle);
}

for (const toolName of [...openClawTools, ...iphoneTools]) {
  assertContains('REALTIME_INSTRUCTIONS expanded prompt', expandedOpenClaw, toolName);
}

for (const toolName of iphoneTools) {
  assertContains('REALTIME_DIRECT_INSTRUCTIONS expanded prompt', expandedDirect, toolName);
}

for (const toolName of [...instantTools, ...iphoneTools]) {
  assertContains('REALTIME_INSTANT_INSTRUCTIONS expanded prompt', expandedInstant, toolName);
}

for (const [name, text] of [
  ['REALTIME_DIRECT_INSTRUCTIONS', direct],
  ['REALTIME_INSTANT_INSTRUCTIONS', instant],
]) {
  assertContains(name, text, 'Operating loop');
  assertContains(name, text, 'Examples and routing patterns');
  assertContains(name, text, 'Capability boundaries');
  assertContains(name, text, 'iPhone-side tools are the device-action layer');
  assertContains(name, text, 'wait_for_user');
  assertContains(name, text, 'iPhone-side tools');
  assertContains(name, text, 'iphone_sync_watch_settings');
  assertContains(name, text, 'iphone_switch_voice_route');
  assertContains(name, text, 'iphone_run_shortcut');
  assertContains(name, text, 'named Apple Shortcuts');
  assertContains(name, text, 'custom iPhone workflows');
  assertContains(name, text, 'calendar event reading/creation');
  assertContains(name, text, 'reminder reading/creation');
  assertContains(name, text, 'selected media analysis');
  assertContains(name, text, 'camera photo analysis');
  assertContains(name, text, 'clipboard image analysis');
  assertContains(name, text, 'WhatsApp handoffs');
  assertContains(name, text, 'Notes share-sheet handoff');
  assertContains(name, text, 'clipboard reading/copying');
  assertContains(name, text, 'Do not repeatedly call the same failed tool');
}

assertContains('REALTIME_INSTANT_INSTRUCTIONS', instant, 'gpt55_instant');
assertContains('server/index.js', source, "name: 'iphone_sync_watch_settings'");
assertContains('server/index.js', source, "name: 'iphone_switch_voice_route'");
assertContains('server/index.js', source, "name: 'iphone_list_calendar_events'");
assertContains('server/index.js', source, "name: 'iphone_list_reminders'");
assertContains('server/index.js', source, "name: 'iphone_analyze_selected_media'");
assertContains('server/index.js', source, "name: 'iphone_capture_photo_for_analysis'");
assertContains('server/index.js', source, "name: 'iphone_analyze_clipboard_image'");
assertContains('server/index.js', source, "name: 'iphone_open_whatsapp'");
assertContains('server/index.js', source, 'function normalizeSidebandToolCallEvents');
assertContains('server/index.js', source, "event.type !== 'response.done'");
assertContains('server/index.js', source, 'functionCalls: toolEvents.length');
