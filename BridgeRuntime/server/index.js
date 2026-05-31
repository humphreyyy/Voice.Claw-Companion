// Voice Bridge — Transport Server
// HTTP server + WebSocket for voice session management
// Serves client assets, handles audio upload/streaming, ASR, TTS, interrupts

import { createServer } from 'node:http';
import { timingSafeEqual } from 'node:crypto';
import { readFile, stat, mkdir, appendFile, readdir, writeFile, unlink } from 'node:fs/promises';
import { accessSync, constants as fsConstants, readFileSync } from 'node:fs';
import { join, extname } from 'node:path';
import { homedir, tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import WebSocket, { WebSocketServer } from 'ws';
import { transcribe } from './asr.js';
import { synthesize, getVoiceOptions, resolveVoiceConfig, getTtsSpeedOptions, getTtsStatus } from './tts.js';
import { generateReply, clearHistory, getProcessingOptions, resolveProcessingConfig, prewarmProcessing, steerActiveReply } from './dialogue.js';
import {
  REALTIME_AUTH_MODE_OPENCLAW_OAUTH,
  buildRealtimeAuthStatus,
  createRealtimeClientSecret,
  realtimeAuthPreferences,
  resolveRealtimeBearer,
} from './realtime-auth.js';

const __dirname = fileURLToPath(new URL('.', import.meta.url));
const CLIENT_DIR = join(__dirname, '..', 'client');
const PORT = parseInt(process.env.VB_PORT || '3100', 10);
const BIND_HOST = (process.env.VB_BIND_HOST || process.env.HOST || '127.0.0.1').trim() || '127.0.0.1';
const RAW_BASE_PATH = (process.env.VB_BASE_PATH || '').trim();
const BASE_PATH = RAW_BASE_PATH
  ? '/' + RAW_BASE_PATH.replace(/^\/+|\/+$/g, '')
  : '';
const WAKE_PHRASE = (process.env.INTERCOM_WAKE_PHRASE || 'Hey').trim() || 'Hey';

// MIME types for static serving
const MIME = {
  '.html': 'text/html',
  '.js':   'application/javascript',
  '.css':  'text/css',
  '.json': 'application/json',
  '.wav':  'audio/wav',
  '.png':  'image/png',
  '.svg':  'image/svg+xml',
  '.ico':  'image/x-icon',
};

const EXECUTABLE_SEARCH_PATHS = [
  '/opt/homebrew/bin',
  '/usr/local/bin',
  '/usr/bin',
  '/bin',
  '/opt/local/bin',
];

function executablePath(name) {
  if (String(name || '').includes('/')) return name;
  const pathEntries = String(process.env.PATH || '')
    .split(':')
    .filter(Boolean);
  for (const dir of [...pathEntries, ...EXECUTABLE_SEARCH_PATHS]) {
    try {
      const candidate = join(dir, name);
      accessSync(candidate, fsConstants.X_OK);
      return candidate;
    } catch {}
  }
  return name;
}

const REALTIME_MODEL = process.env.REALTIME_MODEL || 'gpt-realtime-2';
const REALTIME_TRANSCRIPTION_MODEL = process.env.REALTIME_TRANSCRIPTION_MODEL || 'gpt-realtime-whisper';
const REALTIME_REASONING_EFFORT = process.env.REALTIME_REASONING_EFFORT || 'high';
const REALTIME_TRANSCRIPTION_DEFAULT = !['0', 'false', 'off', 'no'].includes(String(process.env.REALTIME_TRANSCRIPTION_DEFAULT || '0').toLowerCase());
const REALTIME_TRANSCRIPTION_DELAY = process.env.REALTIME_TRANSCRIPTION_DELAY || 'low';
const REALTIME_TRANSCRIPTION_LANGUAGE = process.env.REALTIME_TRANSCRIPTION_LANGUAGE || '';
const REALTIME_TURN_DETECTION_MODE = process.env.REALTIME_TURN_DETECTION_MODE || 'semantic_vad';
const REALTIME_SEMANTIC_VAD_EAGERNESS = process.env.REALTIME_SEMANTIC_VAD_EAGERNESS || 'auto';
const REALTIME_VOICE = process.env.REALTIME_VOICE || 'marin';
const OPENCLAW_AGENT_NAME = process.env.INTERCOM_AGENT || process.env.OPENCLAW_AGENT || 'main';
const REALTIME_LOG_DIR = process.env.REALTIME_LOG_DIR || join(__dirname, '..', 'ops-node', 'logs');
const REALTIME_TRANSCRIPT_LOG = join(REALTIME_LOG_DIR, 'realtime-transcripts.jsonl');
const OPENCLAW_CONFIG = process.env.OPENCLAW_CONFIG || join(homedir(), '.openclaw', 'openclaw.json');
const REALTIME_VAD_THRESHOLD = Number(process.env.REALTIME_VAD_THRESHOLD || 0.68);
const REALTIME_VAD_PREFIX_PADDING_MS = Number(process.env.REALTIME_VAD_PREFIX_PADDING_MS || 240);
const REALTIME_VAD_SILENCE_DURATION_MS = Number(process.env.REALTIME_VAD_SILENCE_DURATION_MS || 330);
const VOICECLAW_BRIDGE_TOKEN = (process.env.VOICECLAW_BRIDGE_TOKEN || process.env.OPENCLAW_GATEWAY_TOKEN || '').trim();
const VOICECLAW_BRIDGE_PASSWORD = (process.env.VOICECLAW_BRIDGE_PASSWORD || process.env.OPENCLAW_GATEWAY_PASSWORD || '').trim();
const MIN_REALTIME_REPLY_TIMEOUT_MS = 10 * 60 * 1000;
const DEFAULT_REALTIME_OPENCLAW_TIMEOUT_MS = 20 * 60 * 1000;
const DEFAULT_WATCH_REALTIME_TURN_TIMEOUT_MS = 10 * 60 * 1000;
const DEFAULT_REALTIME_OPENCLAW_JOB_RETENTION_MS = 60 * 60 * 1000;
const openClawRealtimeJobs = new Map();
const watchRealtimeJobs = new Map();
const watchRealtimeSessions = new Map();

function timeoutAtLeastTenMinutes(value, fallback = MIN_REALTIME_REPLY_TIMEOUT_MS) {
  const numeric = Number(value || fallback);
  return Math.max(MIN_REALTIME_REPLY_TIMEOUT_MS, Number.isFinite(numeric) ? numeric : fallback);
}

function timingSafeStringEqual(left, right) {
  const leftBuffer = Buffer.from(String(left || ''), 'utf8');
  const rightBuffer = Buffer.from(String(right || ''), 'utf8');
  if (leftBuffer.length !== rightBuffer.length) return false;
  return timingSafeEqual(leftBuffer, rightBuffer);
}

function bridgeAuthEnabled() {
  return !!(VOICECLAW_BRIDGE_TOKEN || VOICECLAW_BRIDGE_PASSWORD);
}

function bridgeAuthSummary() {
  return {
    required: bridgeAuthEnabled(),
    bearerToken: !!VOICECLAW_BRIDGE_TOKEN,
    gatewayPassword: !!VOICECLAW_BRIDGE_PASSWORD,
  };
}

function bearerTokenFromRequest(req) {
  const header = String(req.headers.authorization || '').trim();
  const match = header.match(/^Bearer\s+(.+)$/i);
  return match ? match[1].trim() : '';
}

function hasBridgeAuth(req) {
  if (!bridgeAuthEnabled()) return true;

  const bearerToken = bearerTokenFromRequest(req);
  if (VOICECLAW_BRIDGE_TOKEN && timingSafeStringEqual(bearerToken, VOICECLAW_BRIDGE_TOKEN)) {
    return true;
  }

  const gatewayPassword = String(req.headers['x-openclaw-gateway-password'] || '').trim();
  if (VOICECLAW_BRIDGE_PASSWORD && timingSafeStringEqual(gatewayPassword, VOICECLAW_BRIDGE_PASSWORD)) {
    return true;
  }

  return false;
}

function logicalPathForAuth(urlPath) {
  if (BASE_PATH && urlPath.startsWith(`${BASE_PATH}/`)) {
    return urlPath.slice(BASE_PATH.length) || '/';
  }
  return urlPath;
}

function isProtectedBridgePath(urlPath) {
  const logicalPath = logicalPathForAuth(urlPath);
  return logicalPath === '/config'
    || logicalPath.startsWith('/realtime/')
    || logicalPath === '/ws';
}

function requireBridgeAuth(req, res) {
  if (hasBridgeAuth(req)) return true;

  res.writeHead(401, {
    'Content-Type': 'application/json',
    'WWW-Authenticate': 'Bearer realm="VoiceClaw Companion"',
  });
  res.end(JSON.stringify({ ok: false, error: 'VoiceClaw Companion authorization required' }));
  return false;
}

function loadOpenAIKeyFromConfig() {
  try {
    const cfg = JSON.parse(readFileSync(OPENCLAW_CONFIG, 'utf8'));
    return cfg?.messages?.tts?.providers?.openai?.apiKey || '';
  } catch {
    return '';
  }
}

function getOpenAIApiKey() {
  return process.env.OPENAI_API_KEY || loadOpenAIKeyFromConfig();
}

function openAIKeyForRealtimeRequest(req) {
  const forwarded = String(req.headers['x-openai-api-key'] || req.headers['x-voiceclaw-openai-key'] || '').trim();
  return forwarded || getOpenAIApiKey();
}

const IPHONE_TOOL_CAPABILITY_SUMMARY = `
- wait_for_user keeps the session listening without a spoken reply when the latest audio is silence, background noise, TV/music, side conversation, speech not addressed to VoiceClaw, or likely echo of VoiceClaw's own previous speech.
- iphone_status reads current iPhone and VoiceClaw app status, including app version, battery, thermal state, audio route, permission status, locale, timezone, selected GPT-Realtime-2 route, voice settings, and microphone mute state.
- iphone_sync_watch_settings pushes this iPhone's current VoiceClaw settings to the paired Apple Watch app when the user asks to sync, refresh, set up, or update the Watch app.
- Apple Watch can use Direct GPT-Realtime-2 audio requests, Direct GPT-5.5 Instant over cellular with an OpenAI API key, relay OpenClaw through the paired iPhone while reachable, or use an intentionally public HTTPS OpenClaw bridge. watchOS cannot use a private Tailscale URL by itself.
- iphone_set_microphone_muted mutes only this live VoiceClaw in-app microphone after an explicit request such as "mute me" or "mute the mic." Do not use it for voice unmute requests; after muting, the app cannot hear voice until the user unmutes by tapping or another available input. If the tool succeeds, say exactly: "Mic Muted"
- iphone_set_speakerphone_enabled switches only the live VoiceClaw audio output between speakerphone and the default active output such as handset, headphones, or AirPods.
- iphone_set_transcript_visible opens or closes the transcript panel on the VoiceClaw Live tab when the user asks to show, open, hide, close, expand, or collapse the transcript.
- iphone_clear_transcript clears the current Live tab transcript when the user asks to clear, erase, delete, wipe, or reset it.
- iphone_end_voice_session ends the current VoiceClaw live audio session after an explicit request such as "end this session," "hang up," or "stop listening." Do not use it to cancel unrelated Mac/OpenClaw work.
- iphone_restart_voice_session restarts the current VoiceClaw live audio session after the user asks to restart or reconnect. Do not ask for confirmation. Say exactly "Starting a new session." and use the tool immediately. There is no stop-to-cancel window.
- iphone_prepare_voice_route_switch is legacy compatibility only for route switches; prefer iphone_confirm_voice_route_switch for new calls.
- iphone_confirm_voice_route_switch changes VoiceClaw's selected route after an explicit user request to switch VoiceClaw mode or route. Do not ask a confirmation question. Say briefly that VoiceClaw is switching, then use the tool immediately. There is no stop-to-cancel window.
- iphone_cancel_voice_route_switch is legacy compatibility only. Route switches and restarts normally happen immediately, so there should not be a pending switch or restart to cancel.
- iphone_open_voiceclaw_tab opens the Live, Settings, or Diagnostics tab inside VoiceClaw when the user asks to show a VoiceClaw screen.
- iphone_open_app_settings opens the iOS Settings page for VoiceClaw when the user asks to change app permissions.
- iphone_open_url opens a public http or https URL in the user's default browser only when the user asks to open a link.
- iphone_search_web opens public web search results only when the user asks to search or open results instead of getting a spoken answer.
- iphone_open_maps opens Apple Maps for a place search or directions only when the user asks for Maps, a place, route, or navigation on this iPhone.
- iphone_current_location requests this iPhone's current location once only when the user asks where they are, asks for nearby help, or asks for a location-aware action.
- iphone_lookup_contact searches iPhone Contacts only when the user asks to find contact info or fill recipient details for a requested action.
- iphone_start_phone_call opens the iPhone phone-call handoff only when the user clearly asks to call someone. It does not place silent background calls.
- iphone_create_calendar_event creates a calendar event only when the user clearly asks to add or schedule something.
- iphone_list_calendar_events reads a limited list of iPhone Calendar events only when the user explicitly asks what is on their calendar, schedule, agenda, or availability.
- iphone_create_reminder creates a reminder only when the user clearly asks to be reminded or add a reminder.
- iphone_list_reminders reads a limited list of iPhone Reminders only when the user explicitly asks what reminders, tasks, or to-dos they have.
- iphone_draft_email opens an email draft only when the user asks to draft or email someone. It does not send email automatically.
- iphone_draft_message opens a Messages draft only when the user asks to text or message someone. It does not read or send messages automatically.
- iphone_share opens the iOS share sheet for specific text and/or a public URL, including user-requested handoff to Notes; the user chooses the destination.
- iphone_analyze_selected_media opens the iOS photo/video picker after an explicit user request, analyzes one user-selected photo, screenshot, or sampled video frame set through the active VoiceClaw route when possible, and returns the result. It does not silently read the camera roll, live screen, other apps, or WhatsApp.
- iphone_capture_photo_for_analysis opens the iPhone camera after an explicit user request, lets the user take one photo, analyzes that photo through the active VoiceClaw route when possible, and returns the result. It does not silently capture camera images or video.
- iphone_analyze_clipboard_image reads one image currently on the iPhone clipboard after an explicit user request, then analyzes it through the active VoiceClaw route when possible. This is the fastest user-controlled route for screenshot analysis. It does not read the live screen or other apps.
- iphone_open_whatsapp opens a WhatsApp or WhatsApp Business handoff for a specific phone number, optional draft message, or user-provided WhatsApp call link. It cannot silently send messages, read WhatsApp, answer calls, or guarantee that WhatsApp Business rather than WhatsApp handles a universal link.
- iphone_run_shortcut opens a named existing Apple Shortcut only when the user explicitly asks to run that Shortcut. This is the user-controlled route for custom iPhone workflows that public app APIs do not expose directly. You cannot inspect the user's Shortcut list.
- iphone_read_clipboard reads text currently on the iPhone clipboard only after an explicit user request. iOS may show a paste permission prompt.
- iphone_copy_text copies user-approved text to the iPhone clipboard.
- Permission-gated tools such as Location, Contacts, Calendar, Reminders, microphone, camera, and clipboard access may return denied, restricted, unavailable, empty, or prompt-required results. Use iphone_status or the specific tool result to know the actual state; never claim access before a tool returns it.
`;

const CAPABILITY_AWARENESS_INSTRUCTIONS = `
# Capability awareness as VoiceClaw grows
- The active route and active tool list are authoritative for this session. Capabilities can differ by app version, route mode, permissions, Apple Watch reachability, and Companion availability.
- If a tool is present in this session, you may use it according to its function description even if every example below does not mention it. If a capability is described in prose but no matching active tool exists, treat it as unavailable and offer the closest available route.
- Do not under-use OpenClaw in OpenClaw Bridge/Tunnel routes: use GPT-Realtime-2 mainly for live speech, clarification, tiny answers, and local controls, and use OpenClaw for almost all substantive work.
- When the user asks what VoiceClaw can do, explain the current route and group active capabilities as: live GPT-Realtime-2 conversation, iPhone actions, iOS system shortcuts, named Apple Shortcuts, Apple Watch sync or relay, GPT-5.5 Instant if active, and OpenClaw Mac/private-computer work if active.
- Use iphone_status when the user asks about this iPhone, this app, app version, audio route, selected route, permissions, or diagnostics. Use bridge_status when the user asks about OpenClaw queue, active Mac work, sideband health, or Companion runtime state.
- For Apple ecosystem actions, distinguish read, selected-media/camera/clipboard-image analysis, draft/handoff, and write actions. Read Calendar/Reminders only on explicit request; open Mail/Messages/WhatsApp handoffs rather than sending; use the share sheet for Notes or destinations outside built-in tools.
- Permission-gated tools such as Location, Contacts, Calendar, Reminders, microphone, camera, and clipboard access may return denied, restricted, unavailable, empty, or prompt-required results. Use iphone_status or the specific tool result to know the actual state; never claim access before a tool returns it.
`;

const REALTIME_INSTRUCTIONS = process.env.REALTIME_INSTRUCTIONS || `
# Role
- You are VoiceClaw, OpenClaw's high-capability realtime voice layer running on GPT-Realtime-2.
- You are the first responder for natural speech, timing, interruption, audio understanding, quick reasoning, conversation, and immediate spoken flow.
- OpenClaw core is the route's substantive engine for broad reasoning, drafting, planning, analysis, research-like work, multi-step work, and the user's Mac/private/local capabilities.
- Use OpenClaw as the public product name. Do not mention internal agent names in user-facing speech.

# Default behavior
- This is an OpenClaw Bridge/Tunnel route. OpenClaw is not a fallback, not escalation-only, and not only for computer/file/coding work. The user selected this route because OpenClaw should be used liberally as the core resource.
- GPT-Realtime-2 is the live voice layer: use it for natural speech, timing, interruptions, quick acknowledgements, clarifying questions, tiny complete answers, and iPhone-local controls.
- For any substantive request, question, decision, memory/calendar/file/message/browser/coding/business task, advice, explanation, brainstorming, drafting, planning, analysis, research-like work, or anything needing tools/current state/deeper reasoning, call the openclaw_turn tool.
- If the user did not say "OpenClaw," still call openclaw_turn for substantive work. Never say the user must explicitly ask to use OpenClaw in this route.
- If your next words would be "I can't", "I don't know", "I don't have access", "I can't inspect", "I can't open", "I can't control", "I can't see", or a similar limitation for a substantive request, do not say that. Say at most "I'll ask OpenClaw." and immediately call openclaw_turn with the user's full request.
- If GPT-Realtime-2 can give a useful generic partial answer, you may say it briefly, then immediately call openclaw_turn. Do not stop at the generic partial answer for substantive work.
- iPhone-local controls are handled by the VoiceClaw iPhone app, not OpenClaw. If the user asks about VoiceClaw status, microphone muting, speakerphone/default audio output, transcript visibility/clearing, ending/restarting this live session, showing a VoiceClaw tab, app settings, or switching VoiceClaw route/mode, use the matching iphone_* tool instead of openclaw_turn.
- Keep spoken answers concise and natural. Ask a short clarifying question when needed.
- Before calling openclaw_turn, say at most one brief bridge phrase, for example: "On it.", "Checking.", or "One sec." Do not explain the route, tools, architecture, plan, or why you are calling OpenClaw.

# Operating loop
- Listen for the user's actual intent, not just keywords.
- Decide the selected route's right surface: direct GPT-Realtime-2 for tiny spoken answers, one iPhone-side tool for explicit iPhone actions, or openclaw_turn for substantive work.
- Act immediately when the needed tool and arguments are clear.
- If the latest audio is silence, background noise, side conversation, TV/music, or likely your own previous speech echoing back, call wait_for_user and stay quiet.
- If required information is missing, ask only for the next missing value. Call OpenClaw when OpenClaw may be able to discover or infer the missing information.
- After a tool result, speak the user-facing outcome, not JSON, transport details, or implementation mechanics.
- If the user asks what you can do, answer from the active capability map only and describe OpenClaw as the selected core resource for broad substantive work, not a narrow computer-control add-on.
- When explaining capabilities, group them by surface: live GPT-Realtime-2 conversation, explicit iPhone actions, iOS system shortcuts, named Apple Shortcuts, Apple Watch sync or relay, and OpenClaw Mac/private-computer work. Keep the first answer high-level and offer examples if the user wants the complete list.

# Available capability map
- GPT-Realtime-2 direct voice conversation for fast back-and-forth, interruption, clarification, and spoken flow.
- wait_for_user for silence, background audio, side conversations, speech not addressed to VoiceClaw, or likely echo of your own prior speech.
- iOS system shortcuts outside this live session can open VoiceClaw, ask GPT-5.5 Instant, get VoiceClaw status, sync Apple Watch settings, and send explicit requests to OpenClaw without exposing stored credentials.
- openclaw_turn as the default substantive-work path in Bridge/Tunnel. It uses the user's OpenClaw runtime and can handle broad questions, analysis, drafting, planning, research-like work, and Mac/private/local computer capabilities. The user does not need to mention OpenClaw.
- steer_openclaw for follow-up instructions while OpenClaw is already working.
- stop_openclaw to stop or cancel active OpenClaw work.
- bridge_status for OpenClaw bridge status and queue/runtime diagnostics.
- iPhone-side tools for explicit user-requested VoiceClaw tab navigation, Apple Watch settings sync, iOS app permission settings, microphone muting, speakerphone/default audio output, transcript visibility/clearing, live session ending/restarting, route switching, web navigation/search, maps/directions, one-time current location, contact lookup, phone-call handoff, calendar event reading/creation, reminder reading/creation, email drafts, message drafts, selected media analysis, camera photo analysis, clipboard image analysis, WhatsApp handoffs, share-sheet handoff, named Shortcuts, and clipboard reading/copying on the iPhone.
- Apple Watch can use Direct GPT-Realtime-2 audio requests, Direct GPT-5.5 Instant over cellular, relay OpenClaw through the paired iPhone, or use an intentionally public HTTPS OpenClaw bridge; watchOS cannot use a private Tailscale URL by itself.

${CAPABILITY_AWARENESS_INSTRUCTIONS}

# Examples and routing patterns
- "What can you do?" -> answer from this capability map: live GPT-Realtime-2 conversation, iPhone actions, iOS system shortcuts, named Apple Shortcuts, Apple Watch sync or relay, and OpenClaw Mac/private-computer work.
- "Explain this concept", "help me think through this", "rewrite that shorter", or "what should I say?" -> say a brief answer if useful, then use openclaw_turn unless it is obviously a tiny answer that is complete without tools/context.
- "Open that URL", "search the web for X", "show me directions", "what's on my calendar today", "remind me at 5", "what reminders do I have", "save this as a note", "look at this screenshot", "take a picture of this", "I copied a screenshot", "open WhatsApp Business with Sam", "text Alex", "call Sam", "copy this", or "run my Shortcut named X" -> use the matching iPhone-side tool after any needed clarification.
- "Use OpenClaw", "check my Mac", "look in my files", "use the browser on the computer", "work in the repo", "message someone from the Mac", "keep working on this task", "what do you think I should do", "explain this more carefully", or any broad substantive request -> call openclaw_turn.
- If OpenClaw is already active and the user says "also...", "actually...", "change that to...", "add this", or gives a correction, call steer_openclaw instead of openclaw_turn.
- If a tool fails because an exact value is missing, ask for the missing value once. Do not guess hidden phone numbers, emails, Shortcut names, URLs, or file paths.

# Capability boundaries and routing priority
- Direct GPT-Realtime-2 is the live conversation layer. Use it for ordinary answers, clarification, fast back-and-forth, language understanding, interruptible speech, and anything that does not need an external tool.
- iPhone-side tools are the device-action layer. Use them when the user explicitly asks this iPhone to open, show, draft, call, map, search, locate, remind, schedule, share, analyze selected media, capture and analyze a camera photo, analyze a clipboard image, open WhatsApp handoffs, run a named Shortcut, read the clipboard, copy text, mute the VoiceClaw microphone, change VoiceClaw audio output, show/hide/clear the transcript, switch VoiceClaw route, restart, or end this live session.
- OpenClaw is the selected route's core resource and primary background capability. OpenClaw is not a fallback, not escalation-only, and not only for Mac/file/coding work. It can work through the user's Mac/private runtime, but it is not limited to computer work. In this route, use OpenClaw for almost every substantive request, including general questions, analysis, explanation, advice, brainstorming, planning, drafting, research-like work, multi-step work, local/private computer work, files, browser state, coding workspace, shell, dashboards, crons, memory, and long-running tasks.
- Active work controls are part of the OpenClaw route: use bridge_status to inspect active/queued work, steer_openclaw to add follow-up instructions to an active run, and stop_openclaw only when the user asks to cancel OpenClaw work.
- User-controlled write, capture, analysis, or handoff actions on the iPhone should be clear and intentional. Drafts, calls, media analysis, camera capture, clipboard image analysis, calendar event creation, reminder creation, clipboard writes, share sheets, and Shortcut runs require an explicit user request.
- If two capabilities could apply, choose the one that acts closest to the user's requested surface: this iPhone before Mac/private-computer work; direct speech before tool work; clarification before guessing.
- Use direct GPT-Realtime-2 in OpenClaw routes only for brief conversational filler, clarification questions, tiny general answers that are clearly complete without tools/context, and explicit iPhone-local actions that should stay on this iPhone. When in doubt, use OpenClaw.

# When to call OpenClaw
- Call openclaw_turn by default for substantive requests: general questions, advice, explanation, brainstorming, analysis, planning, drafting, multi-step work, coding, research-style synthesis, public or private questions that may benefit from tools/context, and anything involving the user's Mac, local files, local browser state, private messages/mail, private calendar context, memory, dashboards, shell, crons, long-running work, coding workspace, or other local/private computer state.
- If your next words would be "I can't", "I don't know", "I don't have access", "I can't inspect", "I can't open", "I can't control", "I can't see", or a similar limitation for a substantive request, do not say that. Say at most "I'll ask OpenClaw." and immediately call openclaw_turn with the user's full request.
- If the user asks a question that may depend on local/private state, installed apps, a project, a file, a browser, an account, a log, a repo, OpenClaw memory, a running process, or the Mac environment, call openclaw_turn instead of answering that you lack that state.
- If the user asks something broad, judgment-heavy, current, multi-step, research-like, personal, or context-dependent, use OpenClaw even when GPT-Realtime-2 could give a generic partial answer. You may say the generic partial answer first only if it is genuinely helpful, then call openclaw_turn.
- Preserve the user's request faithfully and completely in the tool text.
- Before calling openclaw_turn, say at most one brief bridge phrase, for example: "On it.", "Checking.", or "One sec." Do not explain routing, tools, architecture, or plans unless the user asks.
- Do not invent tool results. Never claim you checked tools, files, memory, calendar, messages, or system state unless openclaw_turn returned that result.
- If OpenClaw is already working and the user gives a correction, extra instruction, scope change, or follow-up for that same work, call steer_openclaw instead of starting a second OpenClaw turn.
- If you are not sure whether OpenClaw is already working, call bridge_status before starting another OpenClaw turn.
- If OpenClaw returns a queue or active-work conflict, treat the user text as steering for the active work instead of creating another new OpenClaw request.

# iPhone-side tools
- Use the matching iPhone-side tool when the user explicitly asks for an action on this iPhone: VoiceClaw tab navigation, Apple Watch settings sync, iOS app permission settings, microphone muting, speakerphone/default audio output, transcript visibility/clearing, live session ending/restarting, route switching, URL opening, web search, Maps/directions, one-time location, Contacts lookup, phone-call handoff, calendar/reminder reading or creation, email/message draft, selected media/camera/clipboard-image analysis, share sheet, named Shortcut, clipboard read, or clipboard copy.
- Do not send iPhone-local actions to OpenClaw unless the user specifically asks for Mac/OpenClaw/private-computer handling.
- iPhone-side tools are answered by the iPhone app, not by OpenClaw on the Mac.
- iPhone-side tools do not grant Mac, file, browser automation, Notes reading, silent Notes creation, message reading, mail reading, shell, or private computer access unless a supplied tool explicitly says so.
- If the user asks to save text or a URL to Notes, use iphone_share and tell them to choose Notes in the share sheet.
${IPHONE_TOOL_CAPABILITY_SUMMARY}

# User-extensible iPhone automation through Shortcuts
- iphone_run_shortcut can run an existing Apple Shortcut by exact name and optional text input. This is the user-controlled route for custom iPhone workflows that public app APIs do not expose directly.
- Use iphone_run_shortcut when the user says "run my Shortcut named X", "I have a Shortcut called X", or asks to pass text to a named Shortcut.
- Do not guess Shortcut names. Do not claim you can inspect, list, create, edit, or understand a Shortcut unless the user tells you what it does.
- If the user asks for an unsupported iPhone capability and no matching built-in tool exists, offer to run a named Shortcut if they have one.

# Tool precision and confirmation
- For exact values such as phone numbers, email addresses, URLs, calendar dates, reminder dates, contact names, and Shortcut names, preserve the user's wording carefully.
- If an exact value is missing or ambiguous, ask for that value before using a tool.
- If a contact search returns several plausible people, ask which one to use before phone, email, or message handoff.
- If the user gives a clear complete request for a reversible handoff, such as opening Maps or opening a draft message, do not add an unnecessary confirmation step.
- Calendar and reminder reads expose private iPhone data. Use them only for explicit user requests, keep summaries tight, and do not browse beyond the requested range or filter.
- Calendar, reminder, email, message, call, and clipboard write actions are write or handoff actions. Use them only for explicit user requests.
- Email and Messages tools open drafts only. The user sends them manually.

# Tool-call speech discipline
- When doing something, do it. Do not narrate mechanics.
- After a successful tool action, give a brief useful completion note. Do not overexplain implementation details unless asked.
- Explain if the user asked for an explanation, the tool failed, or there is a real blocker/choice.
- Do not repeatedly call the same failed tool with the same arguments. Ask for a correction, offer one retry when a transient failure is plausible, or offer an alternate route.
- Use only the tools explicitly provided in this session's tool list. Do not invent, assume, or simulate tools.
- Do not respond conversationally after wait_for_user.
- If OpenClaw is working in the background, keep normal GPT-Realtime-2 conversation and iPhone-side actions available. Do not freeze the conversation just because a Mac task is active.

# Unclear or low-confidence audio
- If audio is missing, blank, environmental noise, a side conversation, TV/music, or likely your own previous speech echoing back, call wait_for_user and say nothing.
- If the user is clearly addressing VoiceClaw but the words are partial or unintelligible, ask briefly: "Say that again?" or "I didn’t catch that."
- Do not route unclear fragments like "you", "thank you", footsteps, keyboard noise, or background machine noise to OpenClaw.
- Preserve explicit short commands when clear: stop, cancel, wait, yes, no, help, hey/OpenClaw wake phrases.

# Language
- Match the user’s language when clear. If the user speaks Hebrew, answer in Hebrew. If mixed, follow the user’s dominant language.

# Interruptions, stop/cancel, and bridge status
- If interrupted, stop speaking immediately. The bridge will preserve OpenClaw work where possible.
- If the user gives additional instructions, corrections, scope changes, follow-up questions, or asks to add something while an OpenClaw request is already active, you CAN and MUST call steer_openclaw with the new text. Do not say you cannot send another request. Do not wait for the previous response. Steering is allowed while work is active and is the correct behavior.
- If the user explicitly says stop, cancel, abort, never mind, or asks what the bridge is doing, call stop_openclaw or bridge_status instead of openclaw_turn.
`;

const REALTIME_DIRECT_INSTRUCTIONS = process.env.REALTIME_DIRECT_INSTRUCTIONS || `
# Role
- You are VoiceClaw in Direct GPT-Realtime-2 mode on the user's iPhone.
- Use GPT-Realtime-2 fully for live voice, interruption, quick reasoning, clarification, and natural spoken flow.
- GPT-Realtime-2 is a full first responder in this mode. Give complete spoken answers directly whenever possible.
- Do not claim access to Mac/private-computer tools, local files, private browser state, private mail/messages, shell, dashboards, or long-running computer work in this mode.

# Available capability map
- GPT-Realtime-2 direct voice conversation for fast back-and-forth, ordinary answers, rewriting, lightweight planning, and spoken interaction.
- wait_for_user keeps the session listening without speaking when the latest audio does not need a response.
- iPhone-side tools for explicit user-requested VoiceClaw screen changes, Apple Watch settings sync, iOS permission settings, microphone muting, speakerphone/default audio output, transcript visibility/clearing, live session ending/restarting, route switching, URLs, web searches, Maps/directions, one-time location, Contacts lookup, phone-call handoff, calendar event reading/creation, reminder reading/creation, email/message drafts, selected media analysis, camera photo analysis, clipboard image analysis, WhatsApp handoffs, Notes share-sheet handoff, general share-sheet handoff, named Shortcuts, and clipboard reading/copying.

${CAPABILITY_AWARENESS_INSTRUCTIONS}

# Operating loop
- Answer directly first when the request can be handled from the conversation, common knowledge, simple reasoning, language understanding, or current context.
- Use exactly one iPhone-side tool when the user explicitly asks this iPhone to act.
- Ask only for the next missing value when details are incomplete.
- After a tool result, speak the outcome rather than JSON or implementation mechanics.

# Capability boundaries
- Direct GPT-Realtime-2 is the live conversation layer.
- iPhone-side tools are the device-action layer for explicit user-requested actions on this iPhone.
- iPhone Calendar and Reminders are available only through the explicit calendar/reminder tools.
- Notes is available only through the share sheet. You cannot read Notes or silently create Notes.
- Use direct speech before tools, this iPhone before any private-computer route, and clarification before guessing.

# Examples and routing patterns
- "What can you do?" -> answer from the actual active tool list, grouped as live GPT-Realtime-2 conversation, explicit iPhone actions, iOS system shortcuts, named Apple Shortcuts, Apple Watch sync or relay, and this route's limits.
- "Explain this", "rewrite this", or "help me think through this" -> answer directly.
- "What's on my calendar today?" -> use iphone_list_calendar_events.
- "Remind me tomorrow" -> use iphone_create_reminder.
- "Save this as a note" -> use iphone_share and tell the user to choose Notes in the share sheet.
- "Sync my Watch settings" -> use iphone_sync_watch_settings.
- "Switch VoiceClaw mode to Tunnel" or "Switch the route to Instant" -> briefly say that VoiceClaw is switching, then call iphone_confirm_voice_route_switch with route "openclaw-public-tunnel" or "gpt55-instant" immediately. Do not ask for confirmation.
- "Run my Shortcut named Start Focus" or "Pass this text to my Shortcut called File This" -> use iphone_run_shortcut with the exact Shortcut name and optional text input.
- "Open that URL", "show me directions", "look at this screenshot", "take a picture of this", "I copied a screenshot", "open WhatsApp Business with Sam", "text Alex", "call Sam", "copy this", or "run my Shortcut named X" -> use the matching iPhone-side tool after any needed clarification.
- If the user asks for Mac/private-computer work, explain that OpenClaw Bridge mode is needed for that specific action.
- If audio is silence, background noise, side conversation, TV/music, speech not addressed to VoiceClaw, or likely echo of your own prior speech, call wait_for_user and do not respond conversationally.
- User-controlled write, capture, analysis, or handoff actions on the iPhone should be clear and intentional. Drafts, calls, media analysis, camera capture, clipboard image analysis, calendar event creation, reminder creation, clipboard writes, share sheets, and Shortcut runs require an explicit user request.
- Use the matching iPhone-side tool when the user explicitly asks this iPhone to do one of those actions. Do not invent private app access.
${IPHONE_TOOL_CAPABILITY_SUMMARY}
- User-extensible iPhone automation through Shortcuts: iphone_run_shortcut can run an existing Apple Shortcut by exact name and optional text input for custom iPhone workflows. Use it when the user names a Shortcut; do not guess Shortcut names or claim you can inspect, list, create, edit, or understand Shortcuts.
- For exact values such as phone numbers, email addresses, URLs, calendar dates, reminder dates, contact names, and Shortcut names, ask for clarification when the value is missing or ambiguous.
- Email and Messages tools open drafts only. The user sends them manually.
- Do not repeatedly call the same failed tool with the same arguments. Ask for a correction, offer one retry when a transient failure is plausible, or offer an alternate route.
- If the user asks for OpenClaw-backed work/current system facts, say briefly that Direct mode needs the OpenClaw Bridge mode for that and continue helpfully with what you can answer directly.
- Keep spoken replies concise, natural, and high-agency. Do not narrate process; give a brief useful completion note when an action finishes.
- If audio is unclear or sounds like your own previous speech echoing back, ask briefly for clarification instead of guessing.
`;

const REALTIME_INSTANT_INSTRUCTIONS = process.env.REALTIME_INSTANT_INSTRUCTIONS || `
# Role
- You are VoiceClaw in GPT-5.5 Instant mode.
- GPT-Realtime-2 is responsible for live voice, timing, interruption, and short conversational answers.
- GPT-Realtime-2 remains a full first responder for direct spoken answers; use GPT-5.5 Instant only when the deeper text/public-web layer materially improves the result.
- Do not claim access to Mac/private-computer tools, local files, private browser state, private mail/messages, shell, dashboards, or long-running computer work in this mode.

# Available capability map
- GPT-Realtime-2 direct voice conversation for fast back-and-forth, interruption, ordinary short answers, clarification, and spoken flow.
- gpt55_instant for richer text answers, drafting, rewriting, planning, substantive reasoning, and current public web questions when it materially improves the answer.
- wait_for_user keeps the session listening without speaking when the latest audio does not need a response.
- iPhone-side tools for explicit user-requested VoiceClaw screen changes, Apple Watch settings sync, iOS permission settings, microphone muting, speakerphone/default audio output, transcript visibility/clearing, live session ending/restarting, route switching, URLs, web searches, Maps/directions, one-time location, Contacts lookup, phone-call handoff, calendar event reading/creation, reminder reading/creation, email/message drafts, selected media analysis, camera photo analysis, clipboard image analysis, WhatsApp handoffs, Notes share-sheet handoff, general share-sheet handoff, named Shortcuts, and clipboard reading/copying.

${CAPABILITY_AWARENESS_INSTRUCTIONS}

# Operating loop
- Answer directly first for quick speech.
- Use gpt55_instant only when it materially improves reasoning, drafting, planning, rewriting, or current public web answers.
- Use exactly one iPhone-side tool when the user explicitly asks this iPhone to act.
- Ask only for the next missing value when details are incomplete.
- After a tool result, speak the outcome rather than JSON or implementation mechanics.

# Capability boundaries
- Direct GPT-Realtime-2 is the live conversation layer.
- GPT-5.5 Instant is the deeper text/public-web reasoning layer. It is not a private Mac or iPhone database reader.
- iPhone-side tools are the device-action layer for explicit user-requested actions on this iPhone.
- iPhone Calendar and Reminders are available only through the explicit calendar/reminder tools.
- Notes is available only through the share sheet. You cannot read Notes or silently create Notes.
- Use direct speech before deeper model/tool work, this iPhone before any private-computer route, and clarification before guessing.

# Examples and routing patterns
- "What can you do?" -> answer from the actual active tool list, grouped as live GPT-Realtime-2 conversation, GPT-5.5 Instant text/public-web help, explicit iPhone actions, iOS system shortcuts, named Apple Shortcuts, Apple Watch sync or relay, and this route's limits.
- Quick conversational turns -> answer directly.
- Rich reasoning, drafting, planning, rewriting, or public/current web questions -> use gpt55_instant.
- "What's on my calendar today?" -> use iphone_list_calendar_events.
- "Remind me tomorrow" -> use iphone_create_reminder.
- "Save this as a note" -> use iphone_share and tell the user to choose Notes in the share sheet.
- "Sync my Watch settings" -> use iphone_sync_watch_settings.
- "Switch VoiceClaw mode to Tunnel" or "Switch the route to Instant" -> briefly say that VoiceClaw is switching, then call iphone_confirm_voice_route_switch with route "openclaw-public-tunnel" or "gpt55-instant" immediately. Do not ask for confirmation.
- "Run my Shortcut named Start Focus" or "Pass this text to my Shortcut called File This" -> use iphone_run_shortcut with the exact Shortcut name and optional text input.
- Explicit iPhone actions such as Maps, calls, drafts, reminders, selected media analysis, camera photo analysis, clipboard image analysis, WhatsApp handoffs, Notes share-sheet handoff, clipboard, Shortcuts, VoiceClaw screens, or URLs -> use the matching iPhone-side tool.
- Do not mention or simulate Mac/private-computer tools in this mode.
- If audio is silence, background noise, side conversation, TV/music, speech not addressed to VoiceClaw, or likely echo of your own prior speech, call wait_for_user and do not respond conversationally.
- User-controlled write or handoff actions on the iPhone should be clear and intentional. Drafts, calls, calendar event creation, reminder creation, clipboard writes, share sheets, and Shortcut runs require an explicit user request.
- For substantive text reasoning, drafting, current public web questions, or answers that benefit from GPT-5.5 Instant, call gpt55_instant.
- When calling gpt55_instant, pass the complete user request in text, include compact conversation context in context, and set web_search true only when current public information is useful.
- Use the matching iPhone-side tool when the user explicitly asks this iPhone to do one of those actions. Do not invent private app access.
${IPHONE_TOOL_CAPABILITY_SUMMARY}
- User-extensible iPhone automation through Shortcuts: iphone_run_shortcut can run an existing Apple Shortcut by exact name and optional text input for custom iPhone workflows. Use it when the user names a Shortcut; do not guess Shortcut names or claim you can inspect, list, create, edit, or understand Shortcuts.
- For exact values such as phone numbers, email addresses, URLs, calendar dates, reminder dates, contact names, and Shortcut names, ask for clarification when the value is missing or ambiguous.
- Email and Messages tools open drafts only. The user sends them manually.
- After gpt55_instant returns, speak its answer naturally as your answer. If it fails, briefly explain that GPT-5.5 Instant could not answer and either answer directly with GPT-Realtime-2 if possible or ask whether the user wants to try again.
- Do not repeatedly call the same failed tool with the same arguments. Ask for a correction, offer one retry when a transient failure is plausible, or offer an alternate route.
- Do not call or mention OpenClaw tools in this mode. Do not claim access to the user's Mac, local files, browser, calendar, mail, messages, shell, or private computer state.
- Keep spoken replies concise, natural, and useful.
- If audio is unclear or sounds like your own previous speech echoing back, ask briefly for clarification instead of guessing.
`;

const REALTIME_GPT55_DIRECT_INSTRUCTIONS = process.env.REALTIME_GPT55_DIRECT_INSTRUCTIONS || `
# Role
- You are VoiceClaw in GPT-5.5 without OpenClaw mode.
- GPT-Realtime-2 is responsible for live voice, timing, interruption, and short conversational answers.
- Use GPT-5.5 Direct only when the full GPT-5.5 model materially improves the answer.

# Available capability map
- GPT-Realtime-2 direct voice conversation for fast back-and-forth, interruption, ordinary short answers, clarification, and spoken flow.
- gpt55_direct for richer GPT-5.5 text answers, drafting, rewriting, planning, complex reasoning, research synthesis, and current public web questions.
- iPhone-side tools for explicit user-requested VoiceClaw screen changes, Apple Watch settings sync, iOS permission settings, microphone muting, speakerphone/default audio output, transcript visibility/clearing, live session ending/restarting, route switching, URLs, web searches, Maps/directions, one-time location, Contacts lookup, phone-call handoff, Calendar/Reminder actions, email/message drafts, selected media analysis, camera photo analysis, clipboard image analysis, WhatsApp handoffs, share sheets, named Shortcuts, and clipboard reading/copying.

# Boundaries
- This route uses the user's iPhone ChatGPT sign-in when available and can use the Companion as a fallback. It does not require an OpenAI API key for GPT-5.5 Direct.
- OpenClaw/Mac/private-computer tools are not available. Do not claim access to local files, browser state, shell, private mail/messages, memory, crons, dashboards, or OpenClaw tools.
- Call gpt55_direct with reasoning "medium" by default.
- If current public information is needed, set web_search true and include relevant context.
`;

const REALTIME_TOOLS = [
  {
    type: 'function',
    name: 'openclaw_turn',
    description: "Default core resource for substantive work in OpenClaw Bridge/Tunnel modes. Use very liberally for broad questions, advice, explanation, analysis, drafting, planning, brainstorming, multi-step work, coding, research-style synthesis, and any local/private Mac capability. The user does not need to mention OpenClaw. Do not use for VoiceClaw tab navigation, iOS app permission settings, current iPhone location, iPhone-side contact lookup, phone-call handoff, calendar/reminder creation, email/message drafting, share-sheet handoff, named Shortcuts, clipboard reading/copying, Maps/directions, URL opening, or public search-results opening unless the user explicitly asks for OpenClaw/Mac handling.",
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        text: { type: 'string', description: 'The exact user request to route through OpenClaw.' },
        urgency: { type: 'string', enum: ['normal', 'interrupt', 'background'], description: 'Use normal by default, interrupt for urgent foreground work, and background for low-urgency long-running work.' }
      },
      required: ['text']
    }
  },
  {
    type: 'function',
    name: 'steer_openclaw',
    description: 'Send follow-up messages, steering instructions, corrections, questions, or scope changes into the currently active OpenClaw request without cancelling it. Use this while OpenClaw is already working; do not claim that another request cannot be sent.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        text: { type: 'string', description: 'The new steering instruction to inject into the active OpenClaw run.' },
        urgency: { type: 'string', enum: ['normal', 'interrupt', 'background'], description: 'Use normal by default, interrupt for urgent corrections, and background for low-urgency additions.' }
      },
      required: ['text']
    }
  },
  {
    type: 'function',
    name: 'stop_openclaw',
    description: 'Stop the active OpenClaw request and clear queued OpenClaw requests when the user explicitly asks to stop, cancel, or abort the work.',
    parameters: { type: 'object', additionalProperties: false, properties: {}, required: [] }
  },
  {
    type: 'function',
    name: 'bridge_status',
    description: 'Report local Realtime bridge state such as selected OpenClaw model, active work, queue, mic mute state, and recent latency.',
    parameters: { type: 'object', additionalProperties: false, properties: {}, required: [] }
  }
];

const INSTANT_REALTIME_TOOLS = [
  {
    type: 'function',
    name: 'gpt55_instant',
    description: "Ask GPT-5.5 Instant, also known as chat-latest, for a fast text answer instead of routing to OpenClaw. Use this in GPT-5.5 Instant mode for substantive reasoning, drafting, current web questions, or answers that benefit from a text model. This tool cannot access the user's Mac, files, calendar, mail, messages, or shell.",
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        text: { type: 'string', description: 'The complete user request for GPT-5.5 Instant.' },
        context: { type: 'string', description: 'Brief conversational context needed to answer correctly.' },
        web_search: { type: 'boolean', description: 'True when current public web information is useful.' }
      },
      required: ['text']
    }
  }
];

const GPT55_DIRECT_REALTIME_TOOLS = [
  {
    type: 'function',
    name: 'gpt55_direct',
    description: "Ask the full GPT-5.5 model through the user's ChatGPT subscription using iPhone ChatGPT sign-in when available, with Companion fallback when configured, without OpenClaw/Mac/private-computer tools. Use for substantive reasoning, drafting, current public web questions, complex reasoning, research, or answers that benefit from a full text model. Reasoning defaults to medium.",
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        text: { type: 'string', description: 'The complete user request for GPT-5.5.' },
        context: { type: 'string', description: 'Brief conversational or web-search context needed to answer correctly.' },
        web_search: { type: 'boolean', description: 'True when current public web information is useful.' },
        reasoning: { type: 'string', enum: ['low', 'medium', 'high', 'xhigh'], description: 'Reasoning level. Defaults to medium.' }
      },
      required: ['text']
    }
  }
];

const IPHONE_REALTIME_TOOLS = [
  {
    type: 'function',
    name: 'wait_for_user',
    description: "Call this when the latest audio does not need a spoken response, such as silence, background noise, TV or music, side conversation, speech not addressed to VoiceClaw, or likely echo of VoiceClaw's own previous speech. This keeps the session listening without speaking.",
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {},
      required: []
    }
  },
  {
    type: 'function',
    name: 'iphone_status',
    description: 'Read current iPhone and VoiceClaw app status: app version, battery, thermal state, audio route, permission status, locale, timezone, GPT-Realtime-2 route, voice settings, and microphone mute state. Use only when the user asks about this phone, this app, audio route, permissions, or current session setup.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        detail: {
          type: 'string',
          enum: ['brief', 'full'],
          description: 'Use full for troubleshooting; brief for ordinary questions.'
        }
      },
      required: []
    }
  },
  {
    type: 'function',
    name: 'iphone_sync_watch_settings',
    description: "Push this iPhone's current VoiceClaw settings to the paired Apple Watch app. Use only when the user asks to sync, refresh, set up, or update VoiceClaw settings on Apple Watch.",
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        reason: { type: 'string', description: 'Brief reason the user asked to sync Watch settings.' }
      },
      required: []
    }
  },
  {
    type: 'function',
    name: 'iphone_set_microphone_muted',
    description: 'Mute only this live VoiceClaw in-app microphone after an explicit user request such as mute me, mute the mic, mic closed, or close the mic. Do not use this tool for voice unmute requests; after muting, VoiceClaw cannot hear voice until the user taps the on-screen mic control or uses another non-voice input. This does not disable the system microphone for other apps. If muted is true and the tool succeeds, say exactly: Mic Muted.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        muted: { type: 'boolean', description: 'True to mute the live VoiceClaw microphone. Do not pass false for voice unmute requests.' },
        reason: { type: 'string', description: 'Brief reason the user requested the mute change.' }
      },
      required: ['muted']
    }
  },
  {
    type: 'function',
    name: 'iphone_set_speakerphone_enabled',
    description: 'Switch only this live VoiceClaw in-app audio output between speakerphone and the default active output such as handset, headphones, AirPods, or another non-speakerphone route. Use when the user explicitly asks to turn speakerphone on/off, use speakerphone, use default audio, use normal audio, use handset audio, or use connected headphones/AirPods. This does not change audio routing for other apps.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        enabled: { type: 'boolean', description: 'True to use speakerphone output; false to use the default active non-speakerphone output.' },
        reason: { type: 'string', description: 'Brief reason the user requested the audio output change.' }
      },
      required: ['enabled']
    }
  },
  {
    type: 'function',
    name: 'iphone_set_transcript_visible',
    description: 'Open or close the transcript panel on the VoiceClaw Live tab. Use when the user explicitly asks to open, show, display, reveal, expand, close, hide, dismiss, or collapse the transcript, transcript panel, bottom transcript panel, or transcript at the bottom. Do not say this ability is unavailable when this tool is present.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        visible: { type: 'boolean', description: 'True to show/open the transcript panel; false to hide/close it.' },
        reason: { type: 'string', description: 'Brief reason the user requested the transcript visibility change.' }
      },
      required: ['visible']
    }
  },
  {
    type: 'function',
    name: 'iphone_clear_transcript',
    description: 'Clear the current transcript on the VoiceClaw Live tab. Use only when the user explicitly asks to clear, erase, delete, wipe, or reset the transcript.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        reason: { type: 'string', description: 'Brief reason the user requested transcript clearing.' }
      },
      required: []
    }
  },
  {
    type: 'function',
    name: 'iphone_end_voice_session',
    description: 'End the current VoiceClaw live audio session. Use only when the user explicitly asks VoiceClaw to end the session, hang up, disconnect, or stop listening. Do not use to cancel unrelated Mac/OpenClaw work.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        reason: { type: 'string', description: 'Brief reason the user asked to end the live session.' }
      },
      required: []
    }
  },
  {
    type: 'function',
    name: 'iphone_restart_voice_session',
    description: 'Restart the current VoiceClaw live audio session after the user explicitly asks to restart, reconnect, refresh, or start over. Do not ask for confirmation; say exactly "Starting a new session." and restart immediately with the microphone unmuted. There is no stop-to-cancel window.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        reason: { type: 'string', description: 'Brief reason the user asked to restart the live session.' }
      },
      required: []
    }
  },
  {
    type: 'function',
    name: 'iphone_prepare_voice_route_switch',
    description: 'Legacy compatibility tool for a VoiceClaw route switch after the user explicitly asks to switch VoiceClaw mode or route. Prefer iphone_confirm_voice_route_switch for new calls. Do not ask a confirmation question; a successful call switches immediately with the microphone unmuted. There is no stop-to-cancel window.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        route: { type: 'string', enum: ['realtime-only', 'gpt55-instant', 'gpt55-direct', 'openclaw-bridge', 'openclaw-public-tunnel'], description: 'Exact target route: realtime-only for Direct GPT-Realtime-2, gpt55-instant for GPT-5.5 Instant, gpt55-direct for GPT-5.5 without OpenClaw, openclaw-bridge for OpenClaw Bridge, or openclaw-public-tunnel for OpenClaw HTTPS Tunnel.' },
        reason: { type: 'string', description: 'Brief reason the user requested this route switch.' }
      },
      required: ['route']
    }
  },
  {
    type: 'function',
    name: 'iphone_confirm_voice_route_switch',
    description: 'Apply a VoiceClaw route switch after the user explicitly asks to switch routes. Do not ask a confirmation question; briefly say VoiceClaw is switching, then switch immediately and restart with the microphone unmuted. There is no stop-to-cancel window.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        route: { type: 'string', enum: ['realtime-only', 'gpt55-instant', 'gpt55-direct', 'openclaw-bridge', 'openclaw-public-tunnel'], description: 'Optional target route if restating the pending switch.' },
        reason: { type: 'string', description: 'Brief reason the user confirmed this switch.' }
      },
      required: []
    }
  },
  {
    type: 'function',
    name: 'iphone_cancel_voice_route_switch',
    description: 'Legacy compatibility tool for cancelling a pending VoiceClaw route switch or restart. Route switches and restarts normally happen immediately now, so there is usually nothing pending to cancel.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        reason: { type: 'string', description: 'Brief reason the user canceled this switch.' }
      },
      required: []
    }
  },
  {
    type: 'function',
    name: 'iphone_open_voiceclaw_tab',
    description: 'Open the Live, Settings, or Diagnostics tab inside the VoiceClaw app. Use only when the user explicitly asks to show or switch to a VoiceClaw screen.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        destination: { type: 'string', enum: ['live', 'settings', 'diagnostics'], description: 'VoiceClaw tab to show.' }
      },
      required: ['destination']
    }
  },
  {
    type: 'function',
    name: 'iphone_open_app_settings',
    description: 'Open the iOS Settings page for VoiceClaw so the user can change permissions such as microphone, camera, location, contacts, calendar, or reminders. Use only when the user asks to change/fix app permissions or open system settings for this app.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        reason: { type: 'string', description: 'Brief reason the user asked to open iOS settings.' }
      },
      required: []
    }
  },
  {
    type: 'function',
    name: 'iphone_open_url',
    description: "Open a public http or https URL on the user's iPhone in their default browser. Use only when the user explicitly asks to open a website, article, search page, map, or web link. Do not use for private Mac/browser access.",
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        url: { type: 'string', description: 'The complete http or https URL to open.' },
        reason: { type: 'string', description: 'Brief reason the user asked to open this URL.' }
      },
      required: ['url']
    }
  },
  {
    type: 'function',
    name: 'iphone_search_web',
    description: 'Open a public web search results page on the user’s iPhone. Use only when the user explicitly asks to search the web or open search results, not when they want GPT-Realtime-2 or GPT-5.5 Instant to answer aloud.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        query: { type: 'string', description: 'The web search query.' }
      },
      required: ['query']
    }
  },
  {
    type: 'function',
    name: 'iphone_open_maps',
    description: 'Open Apple Maps on the user’s iPhone for a place search or directions. Use only when the user explicitly asks for a map, place lookup, route, navigation, or directions on this iPhone.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        mode: { type: 'string', enum: ['search', 'directions'], description: 'Use search for place lookup; directions when the user asks how to get somewhere.' },
        query: { type: 'string', description: 'Place or address to search for. For directions this can be the destination when destination is absent.' },
        destination: { type: 'string', description: 'Destination place or address for directions.' },
        origin: { type: 'string', description: 'Optional origin. Omit to let Maps use current location.' },
        transport: { type: 'string', enum: ['driving', 'walking', 'transit'], description: 'Optional directions mode.' }
      },
      required: ['mode']
    }
  },
  {
    type: 'function',
    name: 'iphone_current_location',
    description: "Request the iPhone's current location once and return coordinates, approximate accuracy, and timestamp. Use only when the user explicitly asks where they are, asks for nearby/location-aware help, or asks to use their current location.",
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        purpose: { type: 'string', description: 'Brief user-facing reason for requesting location.' }
      },
      required: []
    }
  },
  {
    type: 'function',
    name: 'iphone_lookup_contact',
    description: "Search the user's iPhone Contacts for matching people or organizations. Use only when the user explicitly asks to find contact info, call/email someone by name, or fill recipient details for a requested action.",
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        query: { type: 'string', description: 'Name, organization, email, or phone fragment to search for.' },
        limit: { type: 'number', description: 'Maximum matches to return. Defaults to 5 and is capped at 10.' }
      },
      required: ['query']
    }
  },
  {
    type: 'function',
    name: 'iphone_start_phone_call',
    description: 'Open the iPhone phone-call handoff for a specific phone number. Use only when the user explicitly asks to call someone. If the user names a person without giving a number, look up the contact first.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        phone_number: { type: 'string', description: 'The phone number to call. Use a phone number returned by iphone_lookup_contact when available.' },
        label: { type: 'string', description: 'Optional person or place label for the call.' }
      },
      required: ['phone_number']
    }
  },
  {
    type: 'function',
    name: 'iphone_create_calendar_event',
    description: "Create an event in the user's default iPhone calendar. Use only when the user explicitly asks to add, create, schedule, or put an event on the calendar.",
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        title: { type: 'string' },
        start_iso8601: { type: 'string', description: 'Event start time as an ISO 8601 date-time with timezone.' },
        end_iso8601: { type: 'string', description: 'Optional event end time as an ISO 8601 date-time with timezone.' },
        duration_minutes: { type: 'number', description: 'Optional duration when end_iso8601 is not supplied. Defaults to 30.' },
        location: { type: 'string' },
        notes: { type: 'string' }
      },
      required: ['title', 'start_iso8601']
    }
  },
  {
    type: 'function',
    name: 'iphone_list_calendar_events',
    description: "Read upcoming iPhone Calendar events in a limited time range. Use only when the user explicitly asks what is on their calendar, schedule, agenda, or availability. Return concise event summaries; do not read beyond the requested range.",
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        start_iso8601: { type: 'string', description: 'Optional range start as an ISO 8601 date-time with timezone. Defaults to now.' },
        end_iso8601: { type: 'string', description: 'Optional range end as an ISO 8601 date-time with timezone. Defaults to 24 hours after the start.' },
        max_items: { type: 'number', description: 'Maximum events to return. Defaults to 10 and is capped at 25.' },
        include_notes: { type: 'boolean', description: 'True only if the user explicitly asks to include event notes.' }
      },
      required: []
    }
  },
  {
    type: 'function',
    name: 'iphone_create_reminder',
    description: "Create a reminder in the user's default iPhone reminders list. Use only when the user explicitly asks to add a reminder or remind them.",
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        title: { type: 'string' },
        due_iso8601: { type: 'string', description: 'Optional due date/time as an ISO 8601 date-time with timezone.' },
        notes: { type: 'string' }
      },
      required: ['title']
    }
  },
  {
    type: 'function',
    name: 'iphone_list_reminders',
    description: "Read iPhone Reminders in a limited list. Use only when the user explicitly asks what reminders, tasks, or to-dos they have. Defaults to incomplete reminders and returns concise summaries.",
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        include_completed: { type: 'boolean', description: 'True only if the user asks to include completed reminders.' },
        due_before_iso8601: { type: 'string', description: 'Optional due-before filter as an ISO 8601 date-time with timezone.' },
        search: { type: 'string', description: 'Optional text filter for reminder title, notes, or list name.' },
        max_items: { type: 'number', description: 'Maximum reminders to return. Defaults to 10 and is capped at 25.' },
        include_notes: { type: 'boolean', description: 'True only if the user explicitly asks to include reminder notes.' }
      },
      required: []
    }
  },
  {
    type: 'function',
    name: 'iphone_draft_email',
    description: 'Open an email draft on the user’s iPhone. Use only when the user explicitly asks to draft or email someone. This opens a draft and never sends email automatically.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        to: { type: 'array', items: { type: 'string' }, description: 'Recipient email addresses.' },
        subject: { type: 'string' },
        body: { type: 'string' }
      },
      required: ['to']
    }
  },
  {
    type: 'function',
    name: 'iphone_draft_message',
    description: 'Open a Messages draft on the user’s iPhone. Use only when the user explicitly asks to text or message someone. This opens a draft and never sends a message automatically.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        recipients: { type: 'array', items: { type: 'string' }, description: 'Phone numbers or message recipients.' },
        body: { type: 'string', description: 'Optional draft message body.' }
      },
      required: ['recipients']
    }
  },
  {
    type: 'function',
    name: 'iphone_share',
    description: 'Open the iOS share sheet for text and/or a public URL. Use only when the user explicitly asks to share, send through another app, save to another app such as Notes, or hand content to another app. The user chooses the destination; this tool does not send or save automatically.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        text: { type: 'string', description: 'Optional text to share.' },
        url: { type: 'string', description: 'Optional public http or https URL to share.' },
        subject: { type: 'string', description: 'Optional subject for share targets that support it.' }
      },
      required: []
    }
  },
  {
    type: 'function',
    name: 'iphone_analyze_selected_media',
    description: 'Open the iOS photo/video picker so the user can explicitly choose one photo, screenshot, or video, then analyze it through the active VoiceClaw route when possible. Use only when the user asks VoiceClaw to look at, read, analyze, describe, summarize, or reason about selected media. Video support analyzes sampled still frames and basic media context, not every frame or the video audio. This tool cannot silently read the camera roll, live screen, other apps, or WhatsApp.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        prompt: { type: 'string', description: 'What the user wants to know about the selected media.' },
        media_type: { type: 'string', enum: ['any', 'photo', 'video'], description: 'The kind of media to let the user choose. Use any unless the user specifically says photo/screenshot or video.' }
      },
      required: ['prompt']
    }
  },
  {
    type: 'function',
    name: 'iphone_capture_photo_for_analysis',
    description: 'Open the iPhone camera so the user can explicitly take one photo, then analyze it through the active VoiceClaw route when possible. Use only when the user asks VoiceClaw to look through the camera, take a picture, inspect what they are pointing at, read something in front of them, or analyze a new camera photo. This tool cannot silently capture images, record video, read the live screen, or inspect other apps.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        prompt: { type: 'string', description: 'What the user wants to know about the camera photo.' }
      },
      required: ['prompt']
    }
  },
  {
    type: 'function',
    name: 'iphone_analyze_clipboard_image',
    description: 'Read one image currently on the iPhone clipboard, then analyze it through the active VoiceClaw route when possible. Use only when the user explicitly asks VoiceClaw to inspect, read, describe, or analyze a copied image or screenshot. This is a user-controlled screen-reading path after the user screenshots/copies an image. It cannot read the live screen, other apps, WhatsApp, or the camera roll silently.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        prompt: { type: 'string', description: 'What the user wants to know about the clipboard image.' }
      },
      required: ['prompt']
    }
  },
  {
    type: 'function',
    name: 'iphone_open_whatsapp',
    description: 'Open a WhatsApp or WhatsApp Business user handoff for a specific phone number, optional draft message, or a user-provided WhatsApp call link. Use only when the user explicitly asks for WhatsApp or WhatsApp Business. It opens WhatsApp; it cannot read WhatsApp, send automatically, answer calls, silently start calls, or guarantee which WhatsApp app handles a universal link.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        action: { type: 'string', enum: ['chat', 'prepare_call'], description: 'Use chat for messages. Use prepare_call when the user asks for a WhatsApp voice/video call; VoiceClaw opens the chat or call link and the user taps call.' },
        phone_number: { type: 'string', description: 'International phone number for WhatsApp, including country code. Spaces and punctuation are okay.' },
        message: { type: 'string', description: 'Optional draft message to prefill in the WhatsApp chat.' },
        app_preference: { type: 'string', enum: ['any', 'business', 'standard'], description: 'Preferred app. Business uses a best-effort WhatsApp Business URL scheme first, then falls back to the universal wa.me link.' },
        call_link: { type: 'string', description: 'Optional complete WhatsApp call link if the user already has one.' }
      },
      required: ['action']
    }
  },
  {
    type: 'function',
    name: 'iphone_run_shortcut',
    description: 'Run or open an existing Apple Shortcut by exact name on the user’s iPhone. Use only when the user explicitly asks to run a named Shortcut. This is the user-controlled route for custom iPhone workflows that public app APIs do not expose directly. This tool cannot list, inspect, create, edit, or explain Shortcuts.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        name: { type: 'string', description: 'Exact name of the existing Shortcut to run.' },
        input_text: { type: 'string', description: 'Optional text input to pass to the Shortcut.' }
      },
      required: ['name']
    }
  },
  {
    type: 'function',
    name: 'iphone_read_clipboard',
    description: 'Read text currently on the iPhone clipboard. Use only when the user explicitly asks to read, summarize, use, or inspect what is on the clipboard. iOS may show a paste permission prompt.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        purpose: { type: 'string', description: 'Brief user-facing reason for reading the clipboard.' }
      },
      required: []
    }
  },
  {
    type: 'function',
    name: 'iphone_copy_text',
    description: 'Copy text to the iPhone clipboard. Use only when the user explicitly asks to copy specific text.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        text: { type: 'string', description: 'The exact text to copy.' }
      },
      required: ['text']
    }
  }
];

const realtimeTurns = new Map();

const MAX_CLASSIC_PENDING_TURNS = Number(process.env.VB_MAX_PENDING_TURNS || 3);
const MAX_REALTIME_PENDING_TURNS = Number(process.env.VB_REALTIME_MAX_PENDING_TURNS || 3);
const MIN_PROBE_RMS = Number(process.env.VB_PROBE_MIN_RMS || 140);
const MIN_TURN_RMS = Number(process.env.VB_TURN_MIN_RMS || 90);
const MIN_AUDIO_BYTES = Number(process.env.VB_MIN_AUDIO_BYTES || 1200);
const REALTIME_SIDEBAND_ENABLED = !['0', 'false', 'off'].includes(String(process.env.REALTIME_SIDEBAND_ENABLED || '1').toLowerCase());
const REALTIME_SIDEBAND_OPEN_TIMEOUT_MS = Number(process.env.REALTIME_SIDEBAND_OPEN_TIMEOUT_MS || 2500);
const REALTIME_RESPONSE_CREATE_RETRY_MS = Number(process.env.REALTIME_RESPONSE_CREATE_RETRY_MS || 1700);
const REALTIME_RESPONSE_CREATE_ACK_TIMEOUT_MS = Number(process.env.REALTIME_RESPONSE_CREATE_ACK_TIMEOUT_MS || 5000);
const realtimeSidebands = new Map();
const realtimeSidebandStates = new Map();
const realtimeSidebandRetryTimers = new Map();
const realtimePendingCounts = new Map();
const realtimeCancelTombstones = new Map();
const realtimeSessionConfigs = new Map();
const realtimeCompletedResults = new Map();
const REALTIME_RESULT_TTL_MS = Number(process.env.REALTIME_RESULT_TTL_MS || 10 * 60 * 1000);


function parseRealtimeBoolean(value, fallback = false) {
  if (value === undefined || value === null || value === '') return fallback;
  return ['1', 'true', 'yes', 'on'].includes(String(value).toLowerCase());
}

function parseJsonHeader(value) {
  if (!value) return {};
  try { return JSON.parse(decodeURIComponent(String(value))); } catch {}
  try { return JSON.parse(String(value)); } catch {}
  return {};
}

function normalizeRealtimeReasoning(value = '') {
  const clean = String(value || '').toLowerCase();
  return ['none', 'low', 'medium', 'high'].includes(clean) ? clean : REALTIME_REASONING_EFFORT;
}

function normalizeTranscriptionDelay(value = '') {
  const clean = String(value || '').toLowerCase();
  return ['minimal', 'low', 'medium', 'high', 'xhigh'].includes(clean) ? clean : REALTIME_TRANSCRIPTION_DELAY;
}

function normalizeTurnDetectionMode(value = '') {
  const clean = String(value || '').toLowerCase().replace('-', '_');
  if (['semantic', 'semantic_vad'].includes(clean)) return 'semantic_vad';
  if (['server', 'server_vad'].includes(clean)) return 'server_vad';
  if (['none', 'manual', 'off', 'disabled', 'null'].includes(clean)) return 'none';
  return REALTIME_TURN_DETECTION_MODE;
}

function normalizeVadSensitivity(value = '') {
  if (value === undefined || value === null || value === '') return null;
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return null;
  return Math.min(1, Math.max(0, parsed));
}

function vadTuning(sensitivity) {
  if (sensitivity === null || sensitivity === undefined) {
    return {
      semanticEagerness: REALTIME_SEMANTIC_VAD_EAGERNESS,
      threshold: REALTIME_VAD_THRESHOLD,
      silenceDurationMs: REALTIME_VAD_SILENCE_DURATION_MS,
    };
  }
  return {
    semanticEagerness: sensitivity < 0.34 ? 'low' : (sensitivity > 0.66 ? 'high' : 'auto'),
    threshold: Number((0.88 - (sensitivity * 0.40)).toFixed(2)),
    silenceDurationMs: Math.min(540, Math.max(120, Math.floor(540 - (sensitivity * 420)))),
  };
}

function buildRealtimeTurnDetection(mode, sensitivity) {
  const normalized = normalizeTurnDetectionMode(mode);
  const tuning = vadTuning(sensitivity);
  if (normalized === 'none') return null;
  if (normalized === 'semantic_vad') {
    return { type: 'semantic_vad', eagerness: tuning.semanticEagerness, create_response: true, interrupt_response: true };
  }
  return { type: 'server_vad', threshold: tuning.threshold, prefix_padding_ms: REALTIME_VAD_PREFIX_PADDING_MS, silence_duration_ms: tuning.silenceDurationMs, create_response: true, interrupt_response: true };
}

function realtimeRequestOptions(req, routeMode, sessionToken) {
  const url = new URL(req.url, `http://localhost:${PORT}`);
  const processing = parseJsonHeader(req.headers['x-openclaw-processing']);
  const model = String(req.headers['x-realtime-model'] || url.searchParams.get('model') || REALTIME_MODEL).trim() || REALTIME_MODEL;
  const voice = String(req.headers['x-realtime-voice'] || url.searchParams.get('voice') || REALTIME_VOICE).trim() || REALTIME_VOICE;
  const noiseReduction = normalizeRealtimeNoiseReduction(req.headers['x-realtime-noise-reduction'] || url.searchParams.get('noiseReduction'));
  const captions = parseRealtimeBoolean(req.headers['x-realtime-captions'] ?? url.searchParams.get('captions'), REALTIME_TRANSCRIPTION_DEFAULT);
  const turnDetection = normalizeTurnDetectionMode(req.headers['x-realtime-turn-detection'] || url.searchParams.get('vad'));
  const vadSensitivity = normalizeVadSensitivity(req.headers['x-realtime-vad-sensitivity'] ?? url.searchParams.get('vadSensitivity'));
  const realtimeReasoning = normalizeRealtimeReasoning(req.headers['x-realtime-reasoning'] || url.searchParams.get('reasoning'));
  const transcriptionDelay = normalizeTranscriptionDelay(req.headers['x-realtime-transcription-delay'] || url.searchParams.get('transcriptionDelay'));
  const transcriptionLanguage = String(req.headers['x-realtime-transcription-language'] || url.searchParams.get('language') || REALTIME_TRANSCRIPTION_LANGUAGE || '').trim();
  return {
    sessionToken: sanitizeRealtimeSessionToken(sessionToken),
    routeMode,
    processing,
    model,
    voice,
    noiseReduction,
    captions,
    turnDetection,
    vadSensitivity,
    realtimeReasoning,
    transcriptionDelay,
    transcriptionLanguage,
    createdAt: Date.now(),
  };
}

function normalizeRealtimeNoiseReduction(value = '') {
  const clean = String(value || '').toLowerCase().replace('-', '_');
  if (['near', 'near_field'].includes(clean)) return 'near_field';
  if (['far', 'far_field'].includes(clean)) return 'far_field';
  if (['off', 'none', 'disabled', 'null'].includes(clean)) return 'off';
  return 'near_field';
}

function buildRealtimeAudioConfig(options = {}) {
  const input = {};
  if (options.noiseReduction && options.noiseReduction !== 'off') input.noise_reduction = { type: options.noiseReduction };
  if (options.captions) {
    input.transcription = { model: REALTIME_TRANSCRIPTION_MODEL, delay: options.transcriptionDelay || REALTIME_TRANSCRIPTION_DELAY };
    if (options.transcriptionLanguage) input.transcription.language = options.transcriptionLanguage;
  }
  const turnDetection = buildRealtimeTurnDetection(options.turnDetection, options.vadSensitivity);
  input.turn_detection = turnDetection;
  return { input, output: { voice: options.voice || REALTIME_VOICE } };
}

function normalizeActionText(text = '') {
  return String(text || '').trim().replace(/\s+/g, ' ');
}

function actionability(text = '', { allowWake = false, allowShortCommand = true, context = 'turn' } = {}) {
  const clean = normalizeActionText(text);
  const normalized = clean.toLowerCase().replace(/[“”]/g, '"').replace(/[^a-z0-9א-ת\s?!.-]/gi, ' ').replace(/\s+/g, ' ').trim();
  if (!normalized || normalized === '[blank_audio]') return { actionable: false, reason: 'blank', text: clean };
  const noiseOnly = new Set(['you','thank you','thanks','thank','thank you thank you','okay thank you','uh','um','umm','hmm','mm','ah','oh','yeah yeah','no no','keyboard','typing','keyboard clacking','keyboard clicking','typing sounds','footsteps','step','steps','walking','machine noise','machine whirring','background noise','silence','inaudible','unintelligible','blank audio','music','beep']);
  if (noiseOnly.has(normalized)) return { actionable: false, reason: 'noise-only', text: clean };
  if (/^(?:\[?inaudible\]?|\[?unintelligible\]?|\(?no speech detected\)?|\[?blank audio\]?)$/i.test(clean)) return { actionable: false, reason: 'asr-placeholder', text: clean };
  const shortCommands = new Set(['stop','cancel','abort','wait','pause','hold on','yes','no','help','status','weather','calendar','time','timer','reminder','lights','email','mail','messages','dashboard','plate','mic','microphone','voice','realtime','what are you doing','never mind','nevermind']);
  if (allowShortCommand && shortCommands.has(normalized)) return { actionable: true, reason: 'short-command', text: clean };
  if (allowWake && /^(?:hey|hay|heyy|openclaw|open claw|open cloud|open claude)(?:\s|$)/.test(normalized)) return { actionable: true, reason: 'wake', text: clean };
  const words = normalized.split(/\s+/).filter(Boolean);
  if (words.length >= 2) return { actionable: true, reason: 'word-count', text: clean };
  if (/[?!]$/.test(clean) && clean.length >= 3) return { actionable: true, reason: 'punctuated-short', text: clean };
  if (/^[א-ת]{2,}$/.test(normalized)) return { actionable: true, reason: 'hebrew-short', text: clean };
  return { actionable: false, reason: `too-short-${context}`, text: clean };
}

function isKnownAudioContainer(raw) {
  if (!raw || raw.length < 12) return false;
  if (raw.slice(0, 4).toString('ascii') === 'RIFF') return false;
  if (raw.slice(0, 4).toString('ascii') === 'OggS') return true;
  if (raw[0] === 0x1A && raw[1] === 0x45 && raw[2] === 0xDF && raw[3] === 0xA3) return true;
  if (raw[4] === 0x66 && raw[5] === 0x74 && raw[6] === 0x79 && raw[7] === 0x70) return true;
  if (raw.slice(0, 4).toString('ascii') === 'fLaC') return true;
  return false;
}

function audioEnergy(buffer) {
  const raw = Buffer.isBuffer(buffer) ? buffer : Buffer.from(buffer || []);
  if (raw.length < MIN_AUDIO_BYTES) return { rms: 0, peak: 0, samples: 0, tooSmall: true, container: false };
  if (isKnownAudioContainer(raw)) return { rms: null, peak: null, samples: 0, tooSmall: false, container: true };
  let offset = raw.length > 44 && raw.slice(0, 4).toString('ascii') === 'RIFF' ? 44 : 0;
  let sumSq = 0, peak = 0, samples = 0;
  for (let i = offset; i + 1 < raw.length; i += 2) {
    const v = raw.readInt16LE(i); const a = Math.abs(v);
    peak = Math.max(peak, a); sumSq += v * v; samples += 1;
  }
  const rms = samples ? Math.sqrt(sumSq / samples) : 0;
  return { rms, peak, samples, tooSmall: false, container: false };
}

function shouldSkipAudio(buffer, threshold = MIN_TURN_RMS) {
  const e = audioEnergy(buffer);
  return { skip: !e.container && (e.tooSmall || e.rms < threshold), ...e, threshold };
}

function rememberRealtimeCancel(sessionToken, turnId = '') {
  const key = sanitizeRealtimeSessionToken(sessionToken);
  if (!turnId) return;
  const tombstones = realtimeCancelTombstones.get(key) || [];
  tombstones.push({ turnId: String(turnId), at: Date.now() });
  realtimeCancelTombstones.set(key, tombstones.slice(-20));
}

function isRealtimeCancelled(sessionToken, turnId = '') {
  const key = sanitizeRealtimeSessionToken(sessionToken);
  const wanted = String(turnId || '');
  if (!wanted) return false;
  const recent = (realtimeCancelTombstones.get(key) || []).filter((item) => Date.now() - item.at < 120000);
  realtimeCancelTombstones.set(key, recent);
  return recent.some((item) => item.turnId === wanted);
}

function realtimeQueueCount(sessionToken) { return realtimePendingCounts.get(sanitizeRealtimeSessionToken(sessionToken)) || 0; }
function incrementRealtimeQueue(sessionToken) {
  const key = sanitizeRealtimeSessionToken(sessionToken);
  const count = realtimeQueueCount(key);
  if (count >= MAX_REALTIME_PENDING_TURNS) return false;
  realtimePendingCounts.set(key, count + 1);
  return true;
}
function decrementRealtimeQueue(sessionToken) {
  const key = sanitizeRealtimeSessionToken(sessionToken);
  const count = Math.max(0, realtimeQueueCount(key) - 1);
  if (count) realtimePendingCounts.set(key, count); else realtimePendingCounts.delete(key);
}

function pruneRealtimeResults() {
  const now = Date.now();
  for (const [key, result] of realtimeCompletedResults.entries()) {
    if (now - result.completedAt > REALTIME_RESULT_TTL_MS) realtimeCompletedResults.delete(key);
  }
}

function realtimeResultKey(sessionToken, turnId = '') {
  const key = sanitizeRealtimeSessionToken(sessionToken);
  const turn = String(turnId || '').trim();
  return turn ? `${key}::${turn}` : key;
}

function realtimeResultSessionPrefix(sessionToken) {
  return `${sanitizeRealtimeSessionToken(sessionToken)}::`;
}

function clearRealtimeResults(sessionToken) {
  const key = sanitizeRealtimeSessionToken(sessionToken);
  const prefix = realtimeResultSessionPrefix(key);
  realtimeCompletedResults.delete(key);
  for (const storedKey of realtimeCompletedResults.keys()) {
    if (storedKey.startsWith(prefix)) realtimeCompletedResults.delete(storedKey);
  }
}

function rememberRealtimeResult(sessionToken, result = {}) {
  const key = sanitizeRealtimeSessionToken(sessionToken);
  const storedKey = realtimeResultKey(key, result.turnId || '');
  realtimeCompletedResults.set(storedKey, {
    sessionToken: key,
    ok: !!result.ok,
    reply: result.reply || '',
    error: result.error || '',
    turnId: result.turnId || '',
    timings: result.timings || null,
    completedAt: Date.now(),
  });
  pruneRealtimeResults();
}

function latestRealtimeResult(sessionToken, options = {}) {
  pruneRealtimeResults();
  const key = sanitizeRealtimeSessionToken(sessionToken);
  const turnId = String(options.turnId || '').trim();
  const sinceMs = Number(options.sinceMs || 0);
  const consume = !!options.consume;
  let storedKey = realtimeResultKey(key, turnId);
  let result = turnId ? realtimeCompletedResults.get(storedKey) : realtimeCompletedResults.get(key);
  if (!result && !turnId) {
    const prefix = realtimeResultSessionPrefix(key);
    let newestKey = '';
    let newestResult = null;
    for (const [candidateKey, candidate] of realtimeCompletedResults.entries()) {
      if (!candidateKey.startsWith(prefix)) continue;
      if (sinceMs && candidate.completedAt < sinceMs) continue;
      if (!newestResult || candidate.completedAt > newestResult.completedAt) {
        newestKey = candidateKey;
        newestResult = candidate;
      }
    }
    storedKey = newestKey;
    result = newestResult;
  }
  if (!result) return null;
  if (sinceMs && result.completedAt < sinceMs) return null;
  if (consume && storedKey) realtimeCompletedResults.delete(storedKey);
  return {
    ...result,
    completedAgoMs: Date.now() - result.completedAt,
  };
}

function realtimeSidebandStateFor(sessionToken) {
  const key = sanitizeRealtimeSessionToken(sessionToken);
  let state = realtimeSidebandStates.get(key);
  if (!state) {
    state = {
      activeResponseId: null,
      pendingResponseCreates: [],
      lastResponseCreate: null,
      lastResponseCreateReason: '',
      lastResponseCreateAt: null,
      nextResponseRetryAt: null,
      responseCreateAttempts: 0,
      responseCreateCollisions: 0,
      handledCallIds: new Set(),
      lastToolCallId: '',
      lastError: '',
      lastCloseCode: null,
      lastCloseReason: '',
      connectedAt: null,
    };
    realtimeSidebandStates.set(key, state);
  }
  return state;
}

function resetRealtimeSidebandState(sessionToken) {
  const key = sanitizeRealtimeSessionToken(sessionToken);
  clearSidebandResponseRetry(key);
  realtimeSidebandStates.delete(key);
}

function clearSidebandResponseRetry(sessionToken) {
  const key = sanitizeRealtimeSessionToken(sessionToken);
  const timer = realtimeSidebandRetryTimers.get(key);
  if (timer) clearTimeout(timer);
  realtimeSidebandRetryTimers.delete(key);
  const state = realtimeSidebandStates.get(key);
  if (state) state.nextResponseRetryAt = null;
}

function scheduleSidebandResponseRetry(ws, sessionToken, reason = 'retry', delayMs = REALTIME_RESPONSE_CREATE_RETRY_MS) {
  const key = sanitizeRealtimeSessionToken(sessionToken);
  const state = realtimeSidebandStateFor(key);
  clearSidebandResponseRetry(key);
  state.nextResponseRetryAt = new Date(Date.now() + delayMs).toISOString();
  const timer = setTimeout(() => {
    realtimeSidebandRetryTimers.delete(key);
    const latest = realtimeSidebandStateFor(key);
    latest.nextResponseRetryAt = null;
    const currentWs = realtimeSidebands.get(key);
    if (currentWs !== ws || ws?.readyState !== WebSocket.OPEN) return;
    if (latest.activeResponseId === 'requested' || latest.activeResponseId === 'collision-wait') {
      if (latest.lastResponseCreate) queueSidebandResponseCreate(ws, key, latest.lastResponseCreate, `${reason}-retry`);
      latest.activeResponseId = null;
    }
    appendRealtimeLog({ kind: 'sideband_response_create_retry', sessionToken: key, reason, pending: latest.pendingResponseCreates.length });
    flushSidebandResponseCreates(ws, key);
  }, delayMs);
  realtimeSidebandRetryTimers.set(key, timer);
  appendRealtimeLog({ kind: 'sideband_response_create_retry_scheduled', sessionToken: key, reason, delayMs, activeResponseId: state.activeResponseId, pending: state.pendingResponseCreates.length });
}

function closeRealtimeSideband(sessionToken, reason = 'client disconnect', { clearSession = true, clearQueue = true } = {}) {
  const key = sanitizeRealtimeSessionToken(sessionToken);
  clearSidebandResponseRetry(key);
  const ws = realtimeSidebands.get(key);
  if (ws) {
    try { ws.close(1000, reason); } catch {}
    realtimeSidebands.delete(key);
  }
  if (clearSession) realtimeSessionConfigs.delete(key);
  if (clearQueue) realtimePendingCounts.delete(key);
  if (clearSession) resetRealtimeSidebandState(key);
  return !!ws;
}

function bridgeStatusSnapshot(sessionToken = '') {
  const key = sanitizeRealtimeSessionToken(sessionToken);
  const current = realtimeTurns.get(key);
  const sideband = realtimeSidebands.get(key);
  const sidebandState = sideband ? ['connecting', 'open', 'closing', 'closed'][sideband.readyState] || String(sideband.readyState) : 'none';
  const sidebandDiagnostics = realtimeSidebandStates.get(key) || null;
  const sessionConfig = realtimeSessionConfigs.get(key) || null;
  return {
    generatedAt: new Date().toISOString(),
    active: !!current,
    turnId: current?.turnId || null,
    activeForMs: current ? Date.now() - current.startedAt : 0,
    realtimePending: realtimeQueueCount(key),
    maxRealtimePending: MAX_REALTIME_PENDING_TURNS,
    sideband: sidebandState,
    sidebandEnabled: REALTIME_SIDEBAND_ENABLED,
    sidebandDiagnostics: sidebandDiagnostics ? {
      activeResponseId: sidebandDiagnostics.activeResponseId,
      pendingResponseCreates: sidebandDiagnostics.pendingResponseCreates.length,
      handledToolCalls: sidebandDiagnostics.handledCallIds.size,
      lastToolCallId: sidebandDiagnostics.lastToolCallId,
      lastError: sidebandDiagnostics.lastError,
      lastCloseCode: sidebandDiagnostics.lastCloseCode,
      lastCloseReason: sidebandDiagnostics.lastCloseReason,
      connectedAt: sidebandDiagnostics.connectedAt,
      responseCreateAttempts: sidebandDiagnostics.responseCreateAttempts,
      responseCreateCollisions: sidebandDiagnostics.responseCreateCollisions,
      lastResponseCreateReason: sidebandDiagnostics.lastResponseCreateReason,
      lastResponseCreateAt: sidebandDiagnostics.lastResponseCreateAt,
      nextResponseRetryAt: sidebandDiagnostics.nextResponseRetryAt,
    } : null,
    sessionConfig,
    lastResult: latestRealtimeResult(key),
    tts: getTtsStatus(),
  };
}

function sendSidebandEvent(ws, event) {
  if (ws?.readyState !== WebSocket.OPEN) return false;
  ws.send(JSON.stringify(event));
  return true;
}

function queueSidebandResponseCreate(ws, sessionToken, event, reason = 'queued') {
  const key = sanitizeRealtimeSessionToken(sessionToken);
  const state = realtimeSidebandStateFor(key);
  const eventId = String(event?.event_id || '');
  const alreadyQueued = eventId && state.pendingResponseCreates.some((queued) => queued.event_id === eventId);
  if (!alreadyQueued) state.pendingResponseCreates.push(event);
  appendRealtimeLog({ kind: 'sideband_response_create_queued', sessionToken: key, reason, pending: state.pendingResponseCreates.length, activeResponseId: state.activeResponseId });
  flushSidebandResponseCreates(ws, key);
}

function requestSidebandResponseCreate(ws, sessionToken, response = {}, reason = 'tool-output') {
  const key = sanitizeRealtimeSessionToken(sessionToken);
  const state = realtimeSidebandStateFor(key);
  const event = {
    type: 'response.create',
    event_id: `vc-sideband-${reason}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
  };
  if (response && Object.keys(response).length) event.response = response;

  if (state.activeResponseId) {
    queueSidebandResponseCreate(ws, key, event, reason);
    return false;
  }

  state.lastResponseCreate = event;
  state.lastResponseCreateReason = reason;
  state.lastResponseCreateAt = new Date().toISOString();
  state.responseCreateAttempts += 1;
  state.activeResponseId = 'requested';
  const sent = sendSidebandEvent(ws, event);
  appendRealtimeLog({ kind: sent ? 'sideband_response_create_sent' : 'sideband_response_create_send_failed', sessionToken: key, reason, attempts: state.responseCreateAttempts, pending: state.pendingResponseCreates.length });
  if (!sent) {
    state.activeResponseId = null;
    clearSidebandResponseRetry(key);
    queueSidebandResponseCreate(ws, key, event, 'send-failed');
  } else {
    scheduleSidebandResponseRetry(ws, key, 'ack-timeout', REALTIME_RESPONSE_CREATE_ACK_TIMEOUT_MS);
  }
  return sent;
}

function flushSidebandResponseCreates(ws, sessionToken) {
  const key = sanitizeRealtimeSessionToken(sessionToken);
  const state = realtimeSidebandStateFor(key);
  if (state.activeResponseId || ws?.readyState !== WebSocket.OPEN || !state.pendingResponseCreates.length) return false;
  const event = state.pendingResponseCreates.shift();
  state.lastResponseCreate = event;
  state.lastResponseCreateReason = 'queued';
  state.lastResponseCreateAt = new Date().toISOString();
  state.responseCreateAttempts += 1;
  state.activeResponseId = 'requested';
  const sent = sendSidebandEvent(ws, event);
  appendRealtimeLog({ kind: sent ? 'sideband_response_create_flushed' : 'sideband_response_create_flush_failed', sessionToken: key, attempts: state.responseCreateAttempts, pending: state.pendingResponseCreates.length });
  if (!sent) {
    state.activeResponseId = null;
    clearSidebandResponseRetry(key);
    state.pendingResponseCreates.unshift(event);
  } else {
    scheduleSidebandResponseRetry(ws, key, 'ack-timeout', REALTIME_RESPONSE_CREATE_ACK_TIMEOUT_MS);
  }
  return sent;
}

function toolResultSpeechSeed(result) {
  const r = result?.result || result || {};
  if (typeof r.spoken === 'string' && r.spoken.trim()) return r.spoken.trim();
  if (typeof r.summary === 'string' && r.summary.trim()) return r.summary.trim();
  if (typeof result?.summary === 'string' && result.summary.trim()) return result.summary.trim();
  if (typeof result?.error === 'string' && result.error.trim()) return result.error.trim();
  return 'The tool returned a result.';
}

function toolResultAnswerInstructions(result, fallback = '') {
  const seed = toolResultSpeechSeed(result) || fallback || 'The tool returned a result.';
  return `Answer the user conversationally using the function output. Be concise but substantive. Do not say only "done", "completed", "finished", or "successful". State the useful result itself. Start from this result summary, expanding only if the function output contains useful detail:
${seed}`;
}

function isClientOwnedRealtimeTool(name = '') {
  const value = String(name || '');
  return value.startsWith('iphone_') || value.startsWith('android_') || value === 'gpt55_instant' || value === 'wait_for_user';
}

async function handleRealtimeSidebandToolCall(ws, event, sessionToken) {
  const key = sanitizeRealtimeSessionToken(sessionToken);
  const state = realtimeSidebandStateFor(key);
  const name = event.name || event.tool_name || event.function?.name;
  const callId = event.call_id || event.callId || event.item_id || event.id;
  if (!callId) return;
  if (isClientOwnedRealtimeTool(name)) {
    await appendRealtimeLog({ kind: 'sideband_client_tool_ignored', sessionToken: key, name, callId });
    return;
  }
  if (state.handledCallIds.has(callId)) {
    await appendRealtimeLog({ kind: 'sideband_function_duplicate_ignored', sessionToken: key, name, callId });
    return;
  }
  state.handledCallIds.add(callId);
  state.lastToolCallId = callId;
  let args = {};
  try { args = JSON.parse(event.arguments || event.output || '{}'); } catch {}
  await appendRealtimeLog({ kind: 'sideband_function_requested', sessionToken: key, name, callId, args });
  const exact = (text) => `Say exactly this text and nothing else:\n${String(text || '').trim()}`;
  const outputAndSpeak = (output, { speak = true } = {}) => {
    sendSidebandEvent(ws, { type: 'conversation.item.create', item: { type: 'function_call_output', call_id: callId, output } });
    appendRealtimeLog({ kind: 'sideband_function_output_sent', sessionToken: key, name, callId, outputPreview: String(output || '').slice(0, 500) });
    if (speak) {
      requestSidebandResponseCreate(ws, key, { instructions: exact(output) }, name || 'tool-output');
    }
  };
  const outputJsonAndSpeakSummary = (result, { speak = true } = {}) => {
    const output = JSON.stringify(result);
    const spoken = toolResultSpeechSeed(result);
    sendSidebandEvent(ws, { type: 'conversation.item.create', item: { type: 'function_call_output', call_id: callId, output } });
    appendRealtimeLog({ kind: 'sideband_function_output_sent', sessionToken: key, name, callId, ok: result?.ok, outputPreview: output.slice(0, 500) });
    if (speak) {
      requestSidebandResponseCreate(ws, key, { instructions: toolResultAnswerInstructions(result, spoken) }, name || 'tool-summary');
    }
  };
  if (name === 'wait_for_user') { outputAndSpeak('Waiting silently for the user.', { speak: false }); return; }
  if (name === 'realtime_status') { outputAndSpeak(JSON.stringify(bridgeStatusSnapshot(sessionToken))); return; }
  if (name === 'stop_openclaw') { cancelRealtimeTurn(sessionToken, 'sideband stop', '', { force: true }); outputAndSpeak('Stopped.'); return; }
  if (name === 'steer_openclaw') {
    const steerText = String(args.text || '').trim();
    if (!steerText) { outputJsonAndSpeakSummary({ ok: false, error: 'No steering text supplied.' }); return; }
    const result = await steerRealtimeOpenClawTurn({ text: steerText, sessionToken, urgency: args.urgency || 'normal', processing: args.processing || {} });
    outputJsonAndSpeakSummary({ ...result, summary: result.ok ? 'Added that to the active OpenClaw request.' : `OpenClaw steering failed: ${result.error || 'unknown error'}` });
    return;
  }
  if (name === 'bridge_status') { outputAndSpeak(JSON.stringify(bridgeStatusSnapshot(sessionToken))); return; }
  if (name === 'gpt55_direct') {
    const requestText = String(args.text || '').trim();
    if (!requestText) { outputJsonAndSpeakSummary({ ok: false, error: 'No GPT-5.5 request text supplied.' }); return; }
    const context = String(args.context || '').trim();
    const text = context ? `Conversation and web-search context:\n${context}\n\nUser request:\n${requestText}` : requestText;
    const reasoning = ['low', 'medium', 'high', 'xhigh'].includes(String(args.reasoning || '').trim()) ? String(args.reasoning).trim() : 'medium';
    const turnId = `rt-gpt55-direct-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const result = await runRealtimeOpenClawTurn({
      text,
      sessionToken,
      turnId,
      urgency: 'normal',
      processing: { agent: 'gpt55-direct', thinking: reasoning, fastMode: 'on' },
    });
    outputJsonAndSpeakSummary({
      ok: !!result.ok,
      route: 'gpt55_direct',
      model: 'openai/gpt-5.5',
      reasoning,
      answer: result.reply,
      summary: result.ok ? result.reply : `GPT-5.5 Direct failed: ${result.error || 'unknown error'}`,
      error: result.ok ? undefined : result.error,
    });
    return;
  }
  if (name && name !== 'openclaw_turn') return;
  const gate = actionability(args.text || '', { allowWake: false, allowShortCommand: true, context: 'realtime-sideband' });
  if (!gate.actionable) { outputAndSpeak("I didn't catch that. Say it again?"); return; }
  if (!incrementRealtimeQueue(sessionToken)) { outputAndSpeak(`The OpenClaw queue is full (${MAX_REALTIME_PENDING_TURNS} waiting). Say stop or wait a moment.`); return; }
  const turnId = `rt-sideband-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  try {
    const sessionConfig = realtimeSessionConfigs.get(sanitizeRealtimeSessionToken(sessionToken)) || {};
    const result = await runRealtimeOpenClawTurn({ text: gate.text, sessionToken, turnId, urgency: args.urgency || 'normal', processing: { ...(sessionConfig.processing || {}), ...(args.processing || {}) } });
    if (isRealtimeCancelled(sessionToken, turnId)) { outputAndSpeak('Stopped.'); return; }
    outputAndSpeak(result.ok ? result.reply : (result.cancelled ? 'Stopped.' : `OpenClaw bridge error: ${result.error || 'unknown error'}`));
  } finally { decrementRealtimeQueue(sessionToken); }
}

function normalizeSidebandToolCallEvent(event = {}) {
  if (event.type === 'response.function_call_arguments.done') return event;
  if (event.type === 'response.output_item.done' && event.item?.type === 'function_call') {
    return {
      ...event,
      name: event.item.name,
      call_id: event.item.call_id || event.item.id,
      arguments: event.item.arguments || event.arguments || '{}',
    };
  }
  return null;
}

function normalizeSidebandToolCallEvents(event = {}) {
  const single = normalizeSidebandToolCallEvent(event);
  if (single) return [single];
  if (event.type !== 'response.done' || !Array.isArray(event.response?.output)) return [];
  return event.response.output
    .filter((item) => item?.type === 'function_call')
    .map((item) => ({
      ...event,
      name: item.name,
      call_id: item.call_id || item.id,
      arguments: item.arguments || '{}',
    }))
    .filter((item) => item.name && item.call_id);
}

function activeResponseCollisionMessage(event = {}) {
  const message = event?.error?.message || event?.message || '';
  return String(message || '').toLowerCase().includes('already has an active response') ? message : '';
}

async function handleRealtimeSidebandEvent(ws, event, sessionToken) {
  const key = sanitizeRealtimeSessionToken(sessionToken);
  const state = realtimeSidebandStateFor(key);
  const type = event?.type || '';

  if (type === 'response.created') {
    clearSidebandResponseRetry(key);
    state.activeResponseId = event.response?.id || event.response_id || event.id || 'active';
    await appendRealtimeLog({ kind: 'sideband_response_active', sessionToken: key, responseId: state.activeResponseId });
    return;
  }

  if (type === 'response.done' || type === 'response.cancelled' || type === 'response.failed') {
    const toolEvents = normalizeSidebandToolCallEvents(event);
    clearSidebandResponseRetry(key);
    const responseId = state.activeResponseId;
    state.activeResponseId = null;
    await appendRealtimeLog({ kind: 'sideband_response_done', sessionToken: key, responseId, pending: state.pendingResponseCreates.length, type, functionCalls: toolEvents.length });
    for (const toolEvent of toolEvents) {
      await handleRealtimeSidebandToolCall(ws, toolEvent, key);
    }
    flushSidebandResponseCreates(ws, key);
    return;
  }

  if (type.includes('error')) {
    const collision = activeResponseCollisionMessage(event);
    state.lastError = event?.error?.message || event?.message || JSON.stringify(event).slice(0, 500);
    if (collision) {
      state.responseCreateCollisions += 1;
      if (state.lastResponseCreate) queueSidebandResponseCreate(ws, key, state.lastResponseCreate, 'active-response-retry');
      state.activeResponseId = 'collision-wait';
      scheduleSidebandResponseRetry(ws, key, 'active-response-collision', REALTIME_RESPONSE_CREATE_RETRY_MS);
      await appendRealtimeLog({ kind: 'sideband_active_response_collision', sessionToken: key, collisions: state.responseCreateCollisions, pending: state.pendingResponseCreates.length });
      return;
    }
    await appendRealtimeLog({ kind: 'sideband_error_event', sessionToken: key, error: state.lastError });
    return;
  }

  const toolEvents = normalizeSidebandToolCallEvents(event);
  if (toolEvents.length) {
    state.activeResponseId = state.activeResponseId || event.response_id || event.response?.id || 'active';
    for (const toolEvent of toolEvents) {
      await handleRealtimeSidebandToolCall(ws, toolEvent, key);
    }
  }
}

function realtimeCallIdFromLocation(location = '') {
  const clean = String(location || '').trim();
  if (!clean) return '';
  try {
    const parsed = new URL(clean, 'https://api.openai.com');
    return parsed.pathname.split('/').filter(Boolean).pop() || '';
  } catch {
    return clean.split('?')[0].split('/').filter(Boolean).pop() || '';
  }
}

async function startRealtimeSideband(location, sessionToken, apiKey = getOpenAIApiKey()) {
  if (!REALTIME_SIDEBAND_ENABLED || !location || !apiKey) return false;
  const key = sanitizeRealtimeSessionToken(sessionToken);
  const callId = realtimeCallIdFromLocation(location);
  const wsUrl = callId ? `wss://api.openai.com/v1/realtime?call_id=${encodeURIComponent(callId)}` : '';
  if (!wsUrl) return false;
  try {
    const existing = realtimeSidebands.get(key);
    if (existing?.readyState === WebSocket.OPEN || existing?.readyState === WebSocket.CONNECTING) existing.close();
    const ws = new WebSocket(wsUrl, { headers: { Authorization: `Bearer ${apiKey}` } });
    realtimeSidebands.set(key, ws);
    let opened = false;
    const openPromise = new Promise((resolve) => {
      const timer = setTimeout(() => resolve(false), REALTIME_SIDEBAND_OPEN_TIMEOUT_MS);
      ws.once('open', () => { opened = true; clearTimeout(timer); resolve(true); });
      ws.once('error', () => { clearTimeout(timer); resolve(false); });
      ws.once('close', () => { clearTimeout(timer); resolve(false); });
    });
    ws.on('open', () => {
      const state = realtimeSidebandStateFor(key);
      state.connectedAt = new Date().toISOString();
      state.lastError = '';
      appendRealtimeLog({ kind: 'sideband_open', sessionToken: key, callIdPrefix: callId.slice(0, 8) });
    });
    ws.on('message', (data) => {
      let event;
      try { event = JSON.parse(data.toString()); } catch { return; }
      handleRealtimeSidebandEvent(ws, event, key).catch((err) => appendRealtimeLog({ kind: 'sideband_event_error', sessionToken: key, error: err.message }));
    });
    ws.on('close', (code, reason) => {
      if (realtimeSidebands.get(key) === ws) realtimeSidebands.delete(key);
      const state = realtimeSidebandStateFor(key);
      state.lastCloseCode = code;
      state.lastCloseReason = String(reason || '');
      appendRealtimeLog({ kind: 'sideband_close', sessionToken: key, code, reason: String(reason || '') });
    });
    ws.on('error', (err) => {
      if (!opened && realtimeSidebands.get(key) === ws) realtimeSidebands.delete(key);
      const state = realtimeSidebandStateFor(key);
      state.lastError = err.message;
      appendRealtimeLog({ kind: 'sideband_error', sessionToken: key, error: err.message });
    });
    const ready = await openPromise;
    if (!ready || ws.readyState !== WebSocket.OPEN) {
      if (realtimeSidebands.get(key) === ws) realtimeSidebands.delete(key);
      try { ws.close(); } catch {}
      await appendRealtimeLog({ kind: 'sideband_not_ready', sessionToken: key, timeoutMs: REALTIME_SIDEBAND_OPEN_TIMEOUT_MS, callIdPrefix: callId.slice(0, 8) });
      return false;
    }
    return true;
  } catch (err) { appendRealtimeLog({ kind: 'sideband_start_failed', sessionToken: key, error: err.message }); return false; }
}

function sanitizeRealtimeSessionToken(value = '') {
  const cleaned = String(value || '').trim().replace(/[^a-zA-Z0-9_-]+/g, '-').replace(/^-+|-+$/g, '');
  return cleaned || `browser-${Date.now().toString(36)}`;
}

function realtimeOpenClawSessionToken(browserSessionId = '') {
  return `voice-realtime-${sanitizeRealtimeSessionToken(browserSessionId)}-${sanitizeRealtimeSessionToken(OPENCLAW_AGENT_NAME)}`;
}

function realtimeRoutingMode(req) {
  const url = new URL(req.url, `http://localhost:${PORT}`);
  const value = String(url.searchParams.get('route') || req.headers['x-openclaw-route'] || '').toLowerCase();
  if (['instant', 'gpt55', 'gpt-5.5', 'gpt55-instant', 'chat-latest'].includes(value)) return 'instant';
  if (['gpt55-direct', 'gpt-5.5-direct', 'gpt55-without-openclaw', 'without-openclaw'].includes(value)) return 'gpt55-direct';
  if (['hermes', 'hermes-bridge', 'hermes-tailscale', 'hermes-public-tunnel', 'hermes-tunnel', 'hermes-https-tunnel'].includes(value)) return 'hermes';
  return value === 'direct' || value === 'pure' || value === 'realtime-only' ? 'direct' : 'openclaw';
}

function isOpenClawRealtimeRoute(routeMode = '') {
  return routeMode === 'openclaw';
}

function isHermesRealtimeRoute(routeMode = '') {
  return routeMode === 'hermes';
}

function isAgentRealtimeRoute(routeMode = '') {
  return isOpenClawRealtimeRoute(routeMode) || isHermesRealtimeRoute(routeMode);
}

function hasServerOwnedRealtimeTools(routeMode = '') {
  return isAgentRealtimeRoute(routeMode) || routeMode === 'gpt55-direct';
}

function realtimeCurrentContext() {
  const now = new Date();
  const timezone = Intl.DateTimeFormat().resolvedOptions().timeZone || 'local time';
  const formatted = new Intl.DateTimeFormat(undefined, {
    dateStyle: 'full',
    timeStyle: 'short',
    timeZone: timezone,
  }).format(now);
  return `\n# Current context\n- Current local date and time on this Mac: ${formatted} (${timezone}).\n`;
}

function realtimeInstructionsForRoute(routeMode = '') {
  const base = isAgentRealtimeRoute(routeMode)
    ? REALTIME_INSTRUCTIONS
    : (routeMode === 'gpt55-direct' ? REALTIME_GPT55_DIRECT_INSTRUCTIONS : (routeMode === 'instant' ? REALTIME_INSTANT_INSTRUCTIONS : REALTIME_DIRECT_INSTRUCTIONS));
  const runtimeNote = isHermesRealtimeRoute(routeMode)
    ? '\n# Selected agent runtime\n- This route uses Hermes Agent as the selected core resource instead of OpenClaw. The OpenClaw-named tool schemas are compatibility shims; when you call openclaw_turn, steer_openclaw, stop_openclaw, or bridge_status in this route, VoiceClaw routes that work to Hermes Agent through the Companion.\n- Say "Hermes" to the user, not "OpenClaw", when describing the selected route or background work.\n'
    : '';
  return `${base.trim()}${runtimeNote}\n${realtimeCurrentContext()}`.trim();
}

function realtimeToolsForRoute(routeMode = '') {
  if (routeMode === 'instant') return [...INSTANT_REALTIME_TOOLS, ...IPHONE_REALTIME_TOOLS];
  if (routeMode === 'gpt55-direct') return [...GPT55_DIRECT_REALTIME_TOOLS, ...IPHONE_REALTIME_TOOLS];
  return isAgentRealtimeRoute(routeMode) ? [...REALTIME_TOOLS, ...IPHONE_REALTIME_TOOLS] : IPHONE_REALTIME_TOOLS;
}

function watchRealtimeToolsForRoute(routeMode = '') {
  if (routeMode === 'instant') return INSTANT_REALTIME_TOOLS;
  if (routeMode === 'gpt55-direct') return GPT55_DIRECT_REALTIME_TOOLS;
  return isAgentRealtimeRoute(routeMode) ? REALTIME_TOOLS : [];
}

async function appendRealtimeLog(event) {
  try {
    await mkdir(REALTIME_LOG_DIR, { recursive: true });
    await appendFile(REALTIME_TRANSCRIPT_LOG, JSON.stringify({ ts: new Date().toISOString(), ...event }) + '\n');
  } catch (err) {
    console.error('[realtime-log]', err.message);
  }
}

function cancelRealtimeTurn(sessionToken, reason = 'cancelled', turnId = '', { force = false } = {}) {
  const key = sanitizeRealtimeSessionToken(sessionToken);
  const current = realtimeTurns.get(key);
  if (!current) return false;
  const wantedTurnId = String(turnId || '');
  if (!force && wantedTurnId && current.turnId !== wantedTurnId) {
    appendRealtimeLog({ kind: 'cancel_ignored', sessionToken: key, turnId: current.turnId, requestedTurnId: wantedTurnId, reason });
    return false;
  }
  current.controller.abort();
  realtimeTurns.delete(key);
  appendRealtimeLog({ kind: 'cancel', sessionToken: key, turnId: current.turnId, reason });
  return true;
}

function realtimeVoiceTimeoutMs(_urgency = 'normal', _processing = {}) {
  // OpenClaw fallback can legitimately use browser, files, messages, subagents,
  // and other slower local tools. Realtime can still interrupt/cancel/steer turns,
  // so keep the bridge patient enough for real agent work.
  return timeoutAtLeastTenMinutes(process.env.REALTIME_OPENCLAW_TIMEOUT_MS, DEFAULT_REALTIME_OPENCLAW_TIMEOUT_MS);
}

function normalizeRealtimeProcessingPayload(payload = {}) {
  const source = payload && typeof payload === 'object' ? payload : {};
  const processing = source.processing && typeof source.processing === 'object' && !Array.isArray(source.processing)
    ? { ...source.processing }
    : {};
  if (!processing.agent && source.agent) processing.agent = source.agent;
  if (!processing.thinking && source.reasoning) processing.thinking = source.reasoning;
  if (!processing.runtime && !processing.agentRuntime) {
    const rawRoute = String(source.routeMode || source.route || '').toLowerCase();
    if (rawRoute.includes('hermes')) processing.runtime = 'hermes';
  }
  if (!processing.fastMode) processing.fastMode = 'on';
  return processing;
}


async function steerRealtimeOpenClawTurn({ text, sessionToken, urgency, processing }) {
  const cleanedText = String(text || '').trim();
  if (!cleanedText) return { ok: false, error: 'empty steer text' };
  const key = sanitizeRealtimeSessionToken(sessionToken);
  const current = realtimeTurns.get(key);
  if (!current) return { ok: false, error: 'no active OpenClaw turn to steer' };
  const startedAt = Date.now();
  const runtime = String(processing?.runtime || processing?.agentRuntime || '').toLowerCase() === 'hermes' ? 'hermes' : 'openclaw';
  const result = await steerActiveReply(cleanedText, { processing: { ...(processing || {}), sessionToken: realtimeOpenClawSessionToken(key), fastMode: 'on', runtime }, timeoutMs: MIN_REALTIME_REPLY_TIMEOUT_MS });
  await appendRealtimeLog({ kind: 'steer', sessionToken: key, turnId: current.turnId, urgency: urgency || 'normal', ok: !!result.ok, elapsedMs: Date.now() - startedAt, text: cleanedText, error: result.error || '' });
  const label = runtime === 'hermes' ? 'Hermes' : 'OpenClaw';
  return { ok: !!result.ok, steered: !!result.ok, reply: result.ok ? `Added that to the active ${label} request.` : undefined, sessionToken: key, turnId: current.turnId, activeSinceMs: Date.now() - current.startedAt, summary: result.ok ? `Added that to the active ${label} request.` : `${label} steering failed: ${result.error || 'unknown error'}`, error: result.error || undefined };
}

function userFacingOpenClawTurnError(err) {
  const message = String(err?.message || err || '');
  if (/gateway module was not found|callGateway export|module not found|cannot find module/i.test(message)) {
    return {
      code: 'openclaw_unavailable',
      error: 'OpenClaw is not available to the Companion on this Mac. Open or reinstall OpenClaw, then retry from VoiceClaw.',
    };
  }
  if (/ECONNREFUSED|connection refused|failed to connect|could not connect|not running|socket hang up|EHOSTUNREACH|ENETUNREACH/i.test(message)) {
    return {
      code: 'openclaw_not_running',
      error: 'OpenClaw is not running on this Mac, or the Companion cannot reach it. Open OpenClaw, wait until it is ready, then retry from VoiceClaw.',
    };
  }
  if (/unauthorized|forbidden|login|oauth|auth/i.test(message)) {
    return {
      code: 'openclaw_auth_failed',
      error: 'OpenClaw could not authenticate this request. Open OpenClaw on the Mac, confirm your ChatGPT login, then retry from VoiceClaw.',
    };
  }
  return { code: 'openclaw_turn_failed', error: 'OpenClaw turn failed' };
}

async function runRealtimeOpenClawTurn({ text, sessionToken, turnId, urgency, processing }) {
  const cleanedText = String(text || '').trim();
  if (!cleanedText) return { ok: false, error: 'empty text' };

  const key = sanitizeRealtimeSessionToken(sessionToken);
  if (realtimeTurns.has(key)) return await steerRealtimeOpenClawTurn({ text: cleanedText, sessionToken: key, urgency, processing });
  clearRealtimeResults(key);
  const controller = new AbortController();
  const openclawToken = realtimeOpenClawSessionToken(key);
  const runtime = String(processing?.runtime || processing?.agentRuntime || '').toLowerCase() === 'hermes' ? 'hermes' : 'openclaw';
  const runtimeLabel = runtime === 'hermes' ? 'Hermes' : 'OpenClaw';
  const effectiveTurnId = String(turnId || `rt-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`);
  realtimeTurns.set(key, { controller, turnId: effectiveTurnId, startedAt: Date.now() });

  await appendRealtimeLog({ kind: 'user', runtime, sessionToken: key, openclawSessionToken: openclawToken, turnId: effectiveTurnId, urgency: urgency || 'normal', text: cleanedText });

  try {
    const gatewayStartedAt = Date.now();
    const reply = await generateReply(cleanedText, {
      signal: controller.signal,
      processing: { ...(processing || {}), sessionToken: openclawToken, fastMode: 'on', runtime },
      timeoutMs: realtimeVoiceTimeoutMs(urgency, processing || {}),
    });
    const timings = { gatewayMs: Date.now() - gatewayStartedAt, totalMs: Date.now() - realtimeTurns.get(key)?.startedAt };
    if (controller.signal.aborted || realtimeTurns.get(key)?.turnId !== effectiveTurnId) {
      await appendRealtimeLog({ kind: 'stale_reply_suppressed', sessionToken: key, turnId: effectiveTurnId });
      return { ok: false, cancelled: true, error: 'turn cancelled' };
    }
    if (realtimeTurns.get(key)?.turnId === effectiveTurnId) realtimeTurns.delete(key);
    const answer = reply || "I didn't catch that. Say it again.";
    await appendRealtimeLog({ kind: 'assistant', runtime, sessionToken: key, openclawSessionToken: openclawToken, turnId: effectiveTurnId, timings, text: answer });
    rememberRealtimeResult(key, { ok: true, reply: answer, turnId: effectiveTurnId, timings });
    return { ok: true, reply: answer, sessionToken: key, openclawSessionToken: openclawToken, turnId: effectiveTurnId, timings };
  } catch (err) {
    if (realtimeTurns.get(key)?.turnId === effectiveTurnId) realtimeTurns.delete(key);
    if (err.message === 'aborted') {
      await appendRealtimeLog({ kind: 'cancelled', sessionToken: key, turnId: effectiveTurnId });
      return { ok: false, cancelled: true, error: 'turn cancelled' };
    }
    console.error(`[realtime-${runtime}]`, err.message);
    const userFacing = userFacingOpenClawTurnError(err);
    const errorText = runtime === 'hermes' ? (err?.message || `${runtimeLabel} turn failed`) : userFacing.error;
    await appendRealtimeLog({ kind: 'error', runtime, sessionToken: key, turnId: effectiveTurnId, code: userFacing.code, error: err.message });
    rememberRealtimeResult(key, { ok: false, code: userFacing.code, error: errorText, turnId: effectiveTurnId });
    return { ok: false, code: userFacing.code, error: errorText };
  }
}

function cleanupOpenClawRealtimeJobs() {
  const requestedRetentionMs = Number(process.env.REALTIME_OPENCLAW_JOB_RETENTION_MS || DEFAULT_REALTIME_OPENCLAW_JOB_RETENTION_MS);
  const retentionMs = Number.isFinite(requestedRetentionMs)
    ? Math.max(DEFAULT_REALTIME_OPENCLAW_JOB_RETENTION_MS, requestedRetentionMs)
    : DEFAULT_REALTIME_OPENCLAW_JOB_RETENTION_MS;
  const oldest = Date.now() - retentionMs;
  for (const [jobID, job] of openClawRealtimeJobs.entries()) {
    if (job.status === 'running') continue;
    if ((job.updatedAt || job.createdAt || 0) < oldest) openClawRealtimeJobs.delete(jobID);
  }
}

function startOpenClawRealtimeJob({ payload, text }) {
  cleanupOpenClawRealtimeJobs();
  const processing = normalizeRealtimeProcessingPayload(payload);
  const runtime = String(processing.runtime || processing.agentRuntime || '').toLowerCase() === 'hermes' ? 'hermes' : 'openclaw';
  const sessionToken = payload.sessionToken || `${runtime}-job-${Date.now().toString(36)}`;
  if (!incrementRealtimeQueue(sessionToken)) {
    return {
      ok: false,
      status: 'error',
      error: `realtime ${runtime === 'hermes' ? 'Hermes' : 'OpenClaw'} queue is full`,
      queued: realtimeQueueCount(sessionToken),
      maxQueued: MAX_REALTIME_PENDING_TURNS,
    };
  }

  const jobID = `${runtime}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 9)}`;
  const job = {
    id: jobID,
    status: 'running',
    createdAt: Date.now(),
    updatedAt: Date.now(),
    result: null,
    error: '',
    sessionToken: sanitizeRealtimeSessionToken(sessionToken),
  };
  openClawRealtimeJobs.set(jobID, job);
  (async () => {
    try {
      const result = await runRealtimeOpenClawTurn({
        ...payload,
        processing,
        text,
      });
      job.result = { ...result, queue: { pending: realtimeQueueCount(sessionToken), max: MAX_REALTIME_PENDING_TURNS } };
      job.status = result.ok ? 'done' : (result.cancelled ? 'cancelled' : 'error');
      job.error = result.ok ? '' : (result.error || `${runtime === 'hermes' ? 'Hermes' : 'OpenClaw'} realtime job failed.`);
      job.updatedAt = Date.now();
    } catch (error) {
      job.status = 'error';
      job.error = error?.message || String(error);
      job.updatedAt = Date.now();
      await appendRealtimeLog({ kind: 'openclaw_realtime_job_error', jobID, error: job.error });
    } finally {
      decrementRealtimeQueue(sessionToken);
    }
  })();
  return { ok: true, jobID, status: 'running' };
}

function watchRealtimeSessionConfig({ routeMode = 'openclaw', model = REALTIME_MODEL, voice = REALTIME_VOICE, sessionToken = '', processing = {} } = {}) {
  const options = {
    sessionToken: sanitizeRealtimeSessionToken(sessionToken),
    routeMode,
    processing: processing && typeof processing === 'object' ? processing : {},
    model: String(model || REALTIME_MODEL).trim() || REALTIME_MODEL,
    voice: String(voice || REALTIME_VOICE).trim() || REALTIME_VOICE,
    noiseReduction: 'near_field',
    captions: true,
    turnDetection: 'none',
    realtimeReasoning: REALTIME_REASONING_EFFORT,
    transcriptionDelay: 'low',
    createdAt: Date.now(),
  };
  const session = {
    type: 'realtime',
    model: options.model,
    reasoning: { effort: options.realtimeReasoning },
    instructions: realtimeInstructionsForRoute(routeMode),
    audio: buildRealtimeAudioConfig(options),
  };
  const tools = watchRealtimeToolsForRoute(routeMode);
  session.tools = tools;
  session.tool_choice = tools.length ? 'auto' : 'none';
  return { options, session };
}

async function mintWatchRealtimeBearer({ req, session, apiKey }) {
  const resolved = await resolveRealtimeBearer({ req, session, apiKey });
  if (resolved.source === REALTIME_AUTH_MODE_OPENCLAW_OAUTH && resolved.bearer) {
    return resolved;
  }

  if (apiKey) {
    const clientSecret = await createRealtimeClientSecret({ authToken: apiKey, session });
    return {
      ...resolved,
      bearer: clientSecret.value,
      expiresAt: clientSecret.expiresAt,
      source: resolved.source === REALTIME_AUTH_MODE_OPENCLAW_OAUTH ? resolved.source : 'api-key-client-secret',
    };
  }

  return resolved;
}

async function m4aBufferToRealtimePCM(inputBuffer) {
  const id = `voiceclaw-watch-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const inputPath = join(tmpdir(), `${id}.m4a`);
  await writeFile(inputPath, inputBuffer);
  try {
    return await new Promise((resolve, reject) => {
      const child = spawn(executablePath('ffmpeg'), [
        '-hide_banner',
        '-loglevel', 'error',
        '-i', inputPath,
        '-f', 's16le',
        '-acodec', 'pcm_s16le',
        '-ac', '1',
        '-ar', '24000',
        'pipe:1',
      ]);
      const stdout = [];
      const stderr = [];
      child.stdout.on('data', (chunk) => stdout.push(chunk));
      child.stderr.on('data', (chunk) => stderr.push(chunk));
      child.on('error', reject);
      child.on('close', (code) => {
        if (code === 0) {
          resolve(Buffer.concat(stdout));
        } else {
          reject(new Error(`ffmpeg audio conversion failed: ${Buffer.concat(stderr).toString('utf8').slice(0, 300)}`));
        }
      });
    });
  } finally {
    unlink(inputPath).catch(() => {});
  }
}

function realtimeUserMessage(text = '') {
  return {
    type: 'conversation.item.create',
    item: {
      type: 'message',
      role: 'user',
      content: [{ type: 'input_text', text: String(text || '') }],
    },
  };
}

function safeAttachmentFilename(value = '', fallback = 'attachment.bin') {
  const cleaned = String(value || '')
    .replace(/[^\w.\- ]+/g, '_')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 120);
  return cleaned || fallback;
}

async function writeVoiceClawAttachments(sessionToken = '', attachments = []) {
  const safeSession = sanitizeRealtimeSessionToken(sessionToken || `attachment-${Date.now().toString(36)}`);
  const dir = join(tmpdir(), 'voiceclaw-attachments', safeSession);
  await mkdir(dir, { recursive: true });
  const written = [];
  const maxAttachments = Number(process.env.VOICECLAW_ATTACHMENT_MAX_COUNT || 8);
  const maxBytes = Number(process.env.VOICECLAW_ATTACHMENT_MAX_BYTES || 12_000_000);
  for (const [index, attachment] of attachments.slice(0, maxAttachments).entries()) {
    const base64 = String(attachment?.base64 || '').trim();
    if (!base64) continue;
    const bytes = Buffer.from(base64, 'base64');
    if (!bytes.length) continue;
    if (bytes.length > maxBytes) {
      written.push({
        filename: safeAttachmentFilename(attachment?.filename, `attachment-${index + 1}.bin`),
        mimeType: String(attachment?.mimeType || 'application/octet-stream'),
        skipped: true,
        reason: `attachment too large (${bytes.length} bytes)`,
      });
      continue;
    }
    const filename = safeAttachmentFilename(attachment?.filename, `attachment-${index + 1}.bin`);
    const path = join(dir, `${index + 1}-${filename}`);
    await writeFile(path, bytes);
    written.push({
      filename,
      mimeType: String(attachment?.mimeType || 'application/octet-stream'),
      path,
      bytes: bytes.length,
    });
  }
  return written;
}

async function runRealtimeAttachmentAnalysis({ text, sessionToken, urgency = 'normal', processing = {}, attachments = [] } = {}) {
  const key = sanitizeRealtimeSessionToken(sessionToken || `attachment-${Date.now().toString(36)}`);
  const written = await writeVoiceClawAttachments(key, Array.isArray(attachments) ? attachments : []);
  const fileLines = written.length
    ? written.map((file) => {
      if (file.skipped) return `- ${file.filename} (${file.mimeType}): skipped, ${file.reason}`;
      return `- ${file.filename} (${file.mimeType}, ${file.bytes} bytes): ${file.path}`;
    }).join('\n')
    : '- No binary files were attached; answer from the supplied text and context.';
  const prompt = `
VoiceClaw iPhone attachment analysis request.

User request:
${String(text || '').trim() || 'Analyze the attached item and summarize what matters.'}

Attachment files written on this Mac for OpenClaw/tool inspection:
${fileLines}

Use OpenClaw/local tools and model vision as appropriate. If the attachment is an image, inspect it directly when possible. If a file type cannot be read directly, explain that plainly and suggest the most useful next step.
`.trim();
  const reply = await generateReply(prompt, {
    processing: { ...(processing || {}), sessionToken: realtimeOpenClawSessionToken(key), fastMode: 'on' },
    timeoutMs: realtimeVoiceTimeoutMs(urgency, processing || {}),
  });
  await appendRealtimeLog({
    kind: 'attachment_analysis',
    sessionToken: key,
    attachments: written.map((file) => ({ filename: file.filename, mimeType: file.mimeType, bytes: file.bytes || 0, skipped: !!file.skipped })),
    replyPreview: String(reply || '').slice(0, 300),
  });
  return {
    ok: true,
    sessionToken: key,
    reply: reply || 'OpenClaw finished the attachment analysis, but returned no text.',
    attachments: written,
  };
}

function watchRealtimeResponseCreate({ voice = REALTIME_VOICE, instructions = '' } = {}) {
  const response = {
    output_modalities: ['audio'],
    audio: {
      output: {
        format: { type: 'audio/pcm', rate: 24000 },
        voice: String(voice || REALTIME_VOICE),
      },
    },
  };
  if (instructions) response.instructions = instructions;
  return { type: 'response.create', response };
}

const WATCH_REALTIME_SESSION_IDLE_MS = Number(process.env.WATCH_REALTIME_SESSION_IDLE_MS || 10 * 60 * 1000);

function watchRealtimeSessionSignature({ routeMode = '', model = '', voice = '' } = {}) {
  return JSON.stringify({
    routeMode: String(routeMode || ''),
    model: String(model || ''),
    voice: String(voice || ''),
  });
}

function watchRealtimeIsOpen(state) {
  return state?.ws?.readyState === WebSocket.OPEN;
}

function rejectWatchRealtimeWaiters(state, error) {
  if (!state) return;
  state.terminalError = error;
  while (state.waiters.length) {
    const waiter = state.waiters.shift();
    clearTimeout(waiter.timer);
    waiter.reject(error);
  }
}

function closeWatchRealtimeSession(sessionToken, reason = 'watch realtime session closed') {
  const key = sanitizeRealtimeSessionToken(sessionToken);
  const state = watchRealtimeSessions.get(key);
  if (!state) return false;
  state.closing = true;
  watchRealtimeSessions.delete(key);
  rejectWatchRealtimeWaiters(state, new Error(reason));
  try { state.ws?.close(1000, reason); } catch {}
  appendRealtimeLog({ kind: 'watch_realtime_session_closed', sessionToken: key, reason }).catch(() => {});
  return true;
}

function cleanupWatchRealtimeSessions() {
  const oldest = Date.now() - WATCH_REALTIME_SESSION_IDLE_MS;
  for (const [key, state] of watchRealtimeSessions.entries()) {
    if (!watchRealtimeIsOpen(state) || (state.lastUsedAt || 0) < oldest) {
      closeWatchRealtimeSession(key, !watchRealtimeIsOpen(state) ? 'watch realtime socket not open' : 'watch realtime idle timeout');
    }
  }
}

function sendWatchRealtimeEvent(state, event) {
  if (!watchRealtimeIsOpen(state)) throw new Error('GPT-Realtime-2 Watch relay is not open.');
  state.ws.send(JSON.stringify(event));
}

function nextWatchRealtimeEvent(state, timeoutMs) {
  if (state.terminalError) return Promise.reject(state.terminalError);
  if (state.eventQueue.length) return Promise.resolve(state.eventQueue.shift());
  return new Promise((resolve, reject) => {
    const waiter = {
      resolve,
      reject,
      timer: setTimeout(() => {
        const index = state.waiters.indexOf(waiter);
        if (index >= 0) state.waiters.splice(index, 1);
        reject(new Error('GPT-Realtime-2 Watch relay response timed out.'));
      }, timeoutMs),
    };
    state.waiters.push(waiter);
  });
}

async function getWatchRealtimeSession({ req, routeMode, model, voice, session, apiKey, sessionToken }) {
  cleanupWatchRealtimeSessions();
  const key = sanitizeRealtimeSessionToken(sessionToken);
  const signature = watchRealtimeSessionSignature({ routeMode, model, voice });
  const existing = watchRealtimeSessions.get(key);
  if (watchRealtimeIsOpen(existing) && existing.signature === signature) {
    existing.lastUsedAt = Date.now();
    existing.terminalError = null;
    existing.eventQueue = [];
    return existing;
  }
  if (existing) closeWatchRealtimeSession(key, 'watch realtime route changed');

  const realtimeBearer = await resolveRealtimeBearer({ req, session, apiKey });
  const url = `wss://api.openai.com/v1/realtime?model=${encodeURIComponent(model)}`;
  const ws = new WebSocket(url, { headers: { Authorization: `Bearer ${realtimeBearer.bearer}` } });
  const state = {
    key,
    ws,
    signature,
    routeMode,
    model,
    voice,
    authSource: realtimeBearer.source,
    createdAt: Date.now(),
    lastUsedAt: Date.now(),
    eventQueue: [],
    waiters: [],
    terminalError: null,
    closing: false,
    activeTurnId: '',
  };

  ws.on('message', (data) => {
    try {
      const event = JSON.parse(data.toString());
      if (state.waiters.length) {
        const waiter = state.waiters.shift();
        clearTimeout(waiter.timer);
        waiter.resolve(event);
      } else {
        state.eventQueue.push(event);
      }
    } catch (err) {
      rejectWatchRealtimeWaiters(state, err);
    }
  });
  ws.on('error', (err) => {
    rejectWatchRealtimeWaiters(state, err);
  });
  ws.on('close', (code, reason) => {
    if (watchRealtimeSessions.get(key) === state) watchRealtimeSessions.delete(key);
    const message = state.closing ? `GPT-Realtime-2 Watch relay closed (${code}).` : `GPT-Realtime-2 Watch relay closed unexpectedly (${code} ${String(reason || '')}).`;
    rejectWatchRealtimeWaiters(state, new Error(message));
    appendRealtimeLog({ kind: 'watch_realtime_session_socket_close', sessionToken: key, code, reason: String(reason || ''), activeTurnId: state.activeTurnId }).catch(() => {});
  });

  const opened = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('GPT-Realtime-2 Watch relay connection timed out.')), 15000);
    ws.once('open', () => { clearTimeout(timer); resolve(true); });
    ws.once('error', (err) => { clearTimeout(timer); reject(err); });
    ws.once('close', (code, reason) => {
      clearTimeout(timer);
      reject(new Error(`GPT-Realtime-2 Watch relay closed before start (${code} ${String(reason || '')}).`));
    });
  });
  if (!opened) throw new Error('GPT-Realtime-2 Watch relay did not open.');
  watchRealtimeSessions.set(key, state);
  await appendRealtimeLog({ kind: 'watch_realtime_session_opened', sessionToken: key, routeMode, model, voice, authSource: realtimeBearer.source });
  return state;
}

async function runWatchRealtimeTurn({ req, payload }) {
  const routeMode = realtimeRoutingMode({ ...req, url: `${BASE_PATH}/realtime/watch-turn?route=${encodeURIComponent(payload.routeMode || 'openclaw')}`, headers: { ...req.headers, 'x-openclaw-route': payload.routeMode || 'openclaw' } });
  const sessionToken = sanitizeRealtimeSessionToken(payload.sessionToken || req.headers['x-voice-session-token'] || `watch-${Date.now().toString(36)}`);
  const model = String(payload.model || REALTIME_MODEL).trim() || REALTIME_MODEL;
  const voice = String(payload.voice || REALTIME_VOICE).trim() || REALTIME_VOICE;
  const text = String(payload.text || '').trim();
  const context = String(payload.context || '').trim();
  const audioBase64 = String(payload.audioBase64 || '').trim();
  const audioContentType = String(payload.audioContentType || 'audio/m4a').trim();
  if (!text && !audioBase64) throw new Error('Watch Realtime turn needs audio or text.');

  const processing = payload.processing && typeof payload.processing === 'object' ? payload.processing : {};
  const { options, session } = watchRealtimeSessionConfig({ routeMode, model, voice, sessionToken, processing });
  if (context) {
    session.instructions = `${session.instructions || ''}\n\n# Recent VoiceClaw Watch Conversation\n${context}`.trim();
  }
  const apiKey = openAIKeyForRealtimeRequest(req);
  const startedAt = Date.now();
  const key = sanitizeRealtimeSessionToken(sessionToken);
  const watchTurnId = String(payload.turnId || `watch-rt-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`);
  const watchState = await getWatchRealtimeSession({ req, routeMode, model, voice, session, apiKey, sessionToken: key });
  if (watchState.activeTurnId) {
    throw new Error('GPT-Realtime-2 Watch relay already has an active turn. Cancel or wait for the current turn before starting another.');
  }
  watchState.activeTurnId = watchTurnId;
  watchState.lastUsedAt = Date.now();
  watchState.eventQueue = [];
  realtimeSessionConfigs.set(key, { ...options, sessionStartedAt: new Date().toISOString() });
  realtimeSidebandStateFor(key).activeResponseId = null;
  const send = (event) => sendWatchRealtimeEvent(watchState, event);
  const nextRealtimeEvent = (timeoutMs) => nextWatchRealtimeEvent(watchState, timeoutMs);

  send({ type: 'session.update', session });
  if (text) {
    send(realtimeUserMessage(text));
  }
  if (audioBase64) {
    const audioBuffer = Buffer.from(audioBase64, 'base64');
    const pcm = audioContentType.includes('pcm') ? audioBuffer : await m4aBufferToRealtimePCM(audioBuffer);
    if (!pcm.length) throw new Error('Watch audio conversion produced no audio.');
    for (let offset = 0; offset < pcm.length; offset += 96_000) {
      send({ type: 'input_audio_buffer.append', audio: pcm.subarray(offset, offset + 96_000).toString('base64') });
    }
    send({ type: 'input_audio_buffer.commit' });
  }
  send(watchRealtimeResponseCreate({ voice, instructions: 'Answer naturally for Apple Watch. Use OpenClaw tools only when they are needed or explicitly requested.' }));

  let userTranscript = '';
  let assistantText = '';
  let replySource = 'rt2';
  const audioChunks = [];
  const deadline = Date.now() + timeoutAtLeastTenMinutes(process.env.WATCH_REALTIME_TURN_TIMEOUT_MS, DEFAULT_WATCH_REALTIME_TURN_TIMEOUT_MS);
  let openClawFallbackReadyAt = 0;

  try {
    while (Date.now() < deadline) {
      if (openClawFallbackReadyAt && Date.now() - openClawFallbackReadyAt > Number(process.env.WATCH_REALTIME_OPENCLAW_AUDIO_GRACE_MS || 15000)) {
        break;
      }
      let event;
      try {
        event = await nextRealtimeEvent(Math.max(1000, deadline - Date.now()));
      } catch (error) {
        const latest = latestRealtimeResult(key, { sinceMs: startedAt, consume: true });
        if (latest?.ok && latest.reply) {
          assistantText = String(latest.reply);
          replySource = 'openclaw';
          await appendRealtimeLog({
            kind: 'watch_realtime_turn_text_fallback',
            sessionToken: key,
            routeMode,
            reason: error?.message || String(error),
            replyPreview: assistantText.slice(0, 300),
          });
          break;
        }
        if (assistantText.trim()) break;
        throw error;
      }

      if (event?.error) {
        throw new Error(event.error.message || JSON.stringify(event.error));
      }

      await handleRealtimeSidebandEvent(watchState.ws, event, key);
      const latestOpenClawReply = latestRealtimeResult(key, { sinceMs: startedAt, consume: true });
      if (!assistantText.trim() && latestOpenClawReply?.ok && latestOpenClawReply.reply) {
        assistantText = String(latestOpenClawReply.reply);
        replySource = 'openclaw';
        openClawFallbackReadyAt = Date.now();
        await appendRealtimeLog({
          kind: 'watch_realtime_turn_text_fallback',
          sessionToken: key,
          routeMode,
          reason: 'openclaw-result-ready',
          replyPreview: assistantText.slice(0, 300),
        });
        continue;
      }
      const type = event?.type || '';
      if (type === 'conversation.item.input_audio_transcription.completed' && event.transcript) {
        userTranscript = String(event.transcript);
      }
      if ((type.includes('output_audio.delta') || type.includes('audio.delta')) && event.delta) {
        const decoded = Buffer.from(String(event.delta), 'base64');
        if (decoded.length) audioChunks.push(decoded);
      }
      if ((type.includes('output_audio_transcript.delta') || type.includes('audio_transcript.delta') || type.includes('output_text.delta')) && event.delta) {
        assistantText += String(event.delta);
      }
      if (type === 'response.done') {
        const toolEvents = normalizeSidebandToolCallEvents(event);
        const extracted = extractRealtimeText(event);
        if (!assistantText.trim() && extracted) assistantText = extracted;
        if (!toolEvents.length && (assistantText.trim() || audioChunks.length || userTranscript.trim())) {
          break;
        }
      }
    }
  } catch (error) {
    if (watchState.terminalError) closeWatchRealtimeSession(key, error?.message || 'watch realtime terminal error');
    throw error;
  } finally {
    if (watchState.activeTurnId === watchTurnId) watchState.activeTurnId = '';
    watchState.lastUsedAt = Date.now();
  }

  if (!assistantText.trim()) {
    const latest = latestRealtimeResult(key, { sinceMs: startedAt, consume: true });
    if (latest?.ok && latest.reply) {
      assistantText = String(latest.reply);
      replySource = 'openclaw';
    }
  }
  const reply = assistantText.trim() || 'GPT-Realtime-2 returned model audio.';
  const audioData = Buffer.concat(audioChunks);
  const audioSource = audioData.length ? 'rt2' : 'none';
  await appendRealtimeLog({
    kind: 'watch_realtime_turn',
    sessionToken: key,
    routeMode,
    authSource: watchState.authSource,
    replySource,
    audioSource,
    text: text || userTranscript,
    replyPreview: reply.slice(0, 300),
    audioBytes: audioData.length,
    elapsedMs: Date.now() - startedAt,
  });
  return {
    ok: true,
    routeMode,
    sessionToken: key,
    authSource: watchState.authSource,
    replySource,
    audioSource,
    transcript: userTranscript.trim() || text,
    reply,
    audioBase64: audioData.length ? audioData.toString('base64') : '',
    audioContentType: audioData.length ? 'audio/pcm;rate=24000' : '',
    elapsedMs: Date.now() - startedAt,
  };
}

function cleanupWatchRealtimeJobs() {
  const oldest = Date.now() - Number(process.env.WATCH_REALTIME_JOB_RETENTION_MS || 10 * 60 * 1000);
  for (const [jobID, job] of watchRealtimeJobs.entries()) {
    if ((job.updatedAt || job.createdAt || 0) < oldest) watchRealtimeJobs.delete(jobID);
  }
}

function cancelWatchRealtimeJob({ jobID = '', sessionToken = '', turnId = '', reason = 'watch requested cancel' } = {}) {
  cleanupWatchRealtimeJobs();
  const id = String(jobID || '').trim();
  const job = id ? watchRealtimeJobs.get(id) : null;
  const key = sanitizeRealtimeSessionToken(sessionToken || job?.sessionToken || '');
  const cancelledOpenClaw = key ? cancelRealtimeTurn(key, reason, turnId, { force: !turnId }) : false;
  if (key) {
    clearRealtimeResults(key);
    closeWatchRealtimeSession(key, reason);
    const state = realtimeSidebandStates.get(key);
    if (state) {
      state.pendingResponseCreates = [];
      state.activeResponseId = null;
      clearSidebandResponseRetry(key);
    }
  }
  if (job) {
    job.status = 'cancelled';
    job.error = 'Watch Realtime job was cancelled.';
    job.updatedAt = Date.now();
  }
  appendRealtimeLog({ kind: 'watch_realtime_cancel', jobID: id, sessionToken: key, turnId: String(turnId || ''), cancelledOpenClaw, reason });
  return { ok: true, cancelledOpenClaw, jobCancelled: !!job, sessionToken: key };
}

function startWatchRealtimeJob({ req, payload }) {
  cleanupWatchRealtimeJobs();
  const jobID = `watch-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 9)}`;
  const reqForJob = {
    method: 'POST',
    url: `${BASE_PATH}/realtime/watch-turn/start`,
    headers: { ...req.headers },
  };
  const job = {
    id: jobID,
    status: 'running',
    createdAt: Date.now(),
    updatedAt: Date.now(),
    result: null,
    error: '',
    sessionToken: sanitizeRealtimeSessionToken(payload?.sessionToken || req.headers['x-voice-session-token'] || ''),
  };
  watchRealtimeJobs.set(jobID, job);
  (async () => {
    try {
      const result = await runWatchRealtimeTurn({ req: reqForJob, payload });
      if (job.status === 'cancelled') return;
      job.status = 'done';
      job.result = result;
      job.updatedAt = Date.now();
    } catch (error) {
      if (job.status === 'cancelled') return;
      job.status = 'error';
      job.error = error?.message || String(error);
      job.updatedAt = Date.now();
      await appendRealtimeLog({ kind: 'watch_realtime_job_error', jobID, error: job.error });
    }
  })();
  return jobID;
}

function extractRealtimeText(event = {}) {
  const parts = [];
  const output = event?.response?.output;
  if (Array.isArray(output)) {
    for (const item of output) {
      const content = item?.content;
      if (!Array.isArray(content)) continue;
      for (const part of content) {
        if (part?.text) parts.push(String(part.text));
        if (part?.transcript) parts.push(String(part.transcript));
      }
    }
  }
  return parts.join('\n').trim();
}

async function readRequestBody(req, limitBytes = 2_000_000) {
  return (await readRequestBuffer(req, limitBytes)).toString('utf8');
}

async function readRealtimeSessionRequest(req) {
  const contentType = String(req.headers['content-type'] || '');
  if (/multipart\/form-data/i.test(contentType)) {
    const body = await readRequestBuffer(req, Number(process.env.REALTIME_SESSION_MAX_MULTIPART_BYTES || 8_000_000));
    const { fields } = parseMultipartFormData(body, contentType);
    const sdpOffer = String(fields.sdp || '').trim();
    if (!sdpOffer) throw new Error('realtime session multipart request missing sdp');
    let providedSession = null;
    if (fields.session) {
      try {
        const parsed = JSON.parse(fields.session);
        if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) providedSession = parsed;
      } catch (error) {
        throw new Error(`realtime session multipart request has invalid session JSON: ${error.message}`);
      }
    }
    return { sdpOffer, providedSession, transport: 'multipart' };
  }
  return { sdpOffer: await readRequestBody(req), providedSession: null, transport: 'raw-sdp' };
}

async function readRequestBuffer(req, limitBytes = 2_000_000) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > limitBytes) throw new Error('request body too large');
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

function parseMultipartFormData(buffer, contentType = '') {
  const match = String(contentType || '').match(/boundary=(?:"([^"]+)"|([^;]+))/i);
  const boundary = (match?.[1] || match?.[2] || '').trim();
  if (!boundary) throw new Error('multipart boundary missing');

  const delimiter = Buffer.from(`--${boundary}`);
  const fields = {};
  const files = {};
  let cursor = 0;

  while (cursor < buffer.length) {
    const start = buffer.indexOf(delimiter, cursor);
    if (start < 0) break;
    let partStart = start + delimiter.length;
    if (buffer.slice(partStart, partStart + 2).toString() === '--') break;
    if (buffer.slice(partStart, partStart + 2).toString() === '\r\n') partStart += 2;

    const next = buffer.indexOf(delimiter, partStart);
    if (next < 0) break;
    let part = buffer.slice(partStart, next);
    if (part.slice(-2).toString() === '\r\n') part = part.slice(0, -2);

    const headerEnd = part.indexOf(Buffer.from('\r\n\r\n'));
    if (headerEnd < 0) {
      cursor = next;
      continue;
    }
    const headerText = part.slice(0, headerEnd).toString('utf8');
    const content = part.slice(headerEnd + 4);
    const disposition = headerText.split(/\r\n/).find((line) => /^content-disposition:/i.test(line)) || '';
    const name = disposition.match(/name="([^"]+)"/i)?.[1] || '';
    if (!name) {
      cursor = next;
      continue;
    }
    const filename = disposition.match(/filename="([^"]*)"/i)?.[1] || '';
    const mimeType = headerText.match(/^content-type:\s*(.+)$/im)?.[1]?.trim() || 'application/octet-stream';
    if (filename) {
      files[name] = { filename, mimeType, buffer: content };
    } else {
      fields[name] = content.toString('utf8');
    }
    cursor = next;
  }

  return { fields, files };
}

function watchRealtimePayloadFromMultipart(buffer, contentType = '') {
  const { fields, files } = parseMultipartFormData(buffer, contentType);
  let metadata = {};
  try { metadata = JSON.parse(fields.metadata || '{}'); } catch { metadata = {}; }
  const audio = files.audio;
  if (audio?.buffer?.length) {
    metadata.audioBase64 = audio.buffer.toString('base64');
    metadata.audioContentType = metadata.audioContentType || audio.mimeType || 'audio/m4a';
    metadata.audioFilename = audio.filename || 'watch-turn.m4a';
    metadata.transport = 'multipart-file';
    metadata.audioBytes = audio.buffer.length;
  }
  return metadata;
}

// ── HTTP server (static files) ──────────────────────────────────────

const httpServer = createServer(async (req, res) => {
  try {
    let urlPath = new URL(req.url, `http://localhost:${PORT}`).pathname;

    if (urlPath === '/healthz') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true, port: PORT, bindHost: BIND_HOST, basePath: BASE_PATH || '/', wakePhrase: WAKE_PHRASE, realtimeBridge: true, auth: bridgeAuthSummary(), tts: getTtsStatus() }));
      return;
    }

    if (isProtectedBridgePath(urlPath) && !requireBridgeAuth(req, res)) {
      return;
    }

    if (urlPath === '/config') {
      const tts = await getVoiceOptions();
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        ok: true,
        product: 'VoiceClaw Companion',
        auth: bridgeAuthSummary(),
        wsPath: `${BASE_PATH}/ws` || '/ws',
        realtimePath: `${BASE_PATH}/realtime/session` || '/realtime/session',
        processing: getProcessingOptions(),
        wakePhrase: WAKE_PHRASE,
        realtime: { model: REALTIME_MODEL, transcriptionModel: REALTIME_TRANSCRIPTION_MODEL, transcriptionDefault: REALTIME_TRANSCRIPTION_DEFAULT, transcriptionDelay: REALTIME_TRANSCRIPTION_DELAY, reasoningEffort: REALTIME_REASONING_EFFORT, reasoningOptions: ['low', 'medium', 'high'], voice: REALTIME_VOICE, bridge: true, sidebandEnabled: REALTIME_SIDEBAND_ENABLED, transcriptLog: REALTIME_TRANSCRIPT_LOG, turnDetectionDefault: REALTIME_TURN_DETECTION_MODE, turnDetectionOptions: ['semantic_vad', 'server_vad'], cloudAudioDefault: true, localPrivatePath: `${BASE_PATH}/index.html` || '/index.html', transcriptionOptions: ['off', REALTIME_TRANSCRIPTION_MODEL], conversationOptions: ['openclaw-gpt55', 'gpt55-instant', 'gpt55-direct', REALTIME_MODEL], routeModes: ['direct', 'instant', 'gpt55-direct', 'openclaw', 'hermes'], auth: realtimeAuthPreferences(req), openclawTools: REALTIME_TOOLS.map(({ name, description }) => ({ name, description })), gpt55DirectTools: GPT55_DIRECT_REALTIME_TOOLS.map(({ name, description }) => ({ name, description })) },
        tts,
      }));
      return;
    }

    if (req.method === 'POST' && urlPath === `${BASE_PATH}/realtime/prewarm`) {
      const body = await readRequestBody(req, 100_000).catch(() => '{}');
      let payload;
      try { payload = JSON.parse(body || '{}'); } catch { payload = {}; }
      try {
        const key = sanitizeRealtimeSessionToken(payload.sessionToken);
        const openclawToken = realtimeOpenClawSessionToken(key);
        const result = await prewarmProcessing({ ...(payload.processing || {}), sessionToken: openclawToken, fastMode: 'on' });
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true, sessionToken: key, openclawSessionToken: openclawToken, ...result }));
      } catch (err) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: false, error: err.message }));
      }
      return;
    }


    if (req.method === 'POST' && urlPath === `${BASE_PATH}/realtime/steer`) {
      const body = await readRequestBody(req, 200_000).catch(() => '{}');
      let payload;
      try { payload = JSON.parse(body || '{}'); } catch { payload = {}; }
      const gate = actionability(payload.text || '', { allowWake: false, allowShortCommand: true, context: 'realtime-steer' });
      if (!gate.actionable) {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: false, filtered: true, reason: gate.reason, error: 'unclear or non-actionable steering text' }));
        return;
      }
      const result = await steerRealtimeOpenClawTurn({ ...payload, processing: normalizeRealtimeProcessingPayload(payload), text: gate.text });
      res.writeHead(result.ok ? 200 : 409, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(result));
      return;
    }

    if (req.method === 'POST' && urlPath === `${BASE_PATH}/realtime/openclaw-turn/start`) {
      const body = await readRequestBody(req, 200_000);
      let payload;
      try { payload = JSON.parse(body || '{}'); } catch { payload = {}; }
      const gate = actionability(payload.text || '', { allowWake: false, allowShortCommand: true, context: 'realtime-http-job' });
      if (!gate.actionable) {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: false, filtered: true, reason: gate.reason, error: 'unclear or non-actionable audio' }));
        return;
      }
      const result = startOpenClawRealtimeJob({ payload, text: gate.text });
      res.writeHead(result.ok ? 202 : 429, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(result));
      return;
    }

    if (req.method === 'GET' && urlPath === `${BASE_PATH}/realtime/openclaw-turn/result`) {
      cleanupOpenClawRealtimeJobs();
      const url = new URL(req.url, `http://localhost:${PORT}`);
      const jobID = url.searchParams.get('jobID') || url.searchParams.get('jobId') || '';
      const job = openClawRealtimeJobs.get(jobID);
      if (!job) {
        res.writeHead(404, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: false, status: 'missing', error: 'OpenClaw realtime job was not found.' }));
        return;
      }
      if (job.status === 'done') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true, status: 'done', result: job.result }));
        return;
      }
      if (job.status === 'error') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: false, status: 'error', error: job.error || 'OpenClaw realtime job failed.', result: job.result }));
        return;
      }
      if (job.status === 'cancelled') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: false, status: 'cancelled', error: job.error || 'OpenClaw realtime job was cancelled.', result: job.result }));
        return;
      }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true, status: job.status || 'running' }));
      return;
    }

    if (req.method === 'POST' && urlPath === `${BASE_PATH}/realtime/openclaw-turn`) {
      const body = await readRequestBody(req, 200_000);
      let payload;
      try { payload = JSON.parse(body || '{}'); } catch { payload = {}; }
      const gate = actionability(payload.text || '', { allowWake: false, allowShortCommand: true, context: 'realtime-http' });
      if (!gate.actionable) {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: false, filtered: true, reason: gate.reason, error: 'unclear or non-actionable audio' }));
        return;
      }
      if (!incrementRealtimeQueue(payload.sessionToken)) {
        res.writeHead(429, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: false, queued: realtimeQueueCount(payload.sessionToken), maxQueued: MAX_REALTIME_PENDING_TURNS, error: 'realtime OpenClaw queue is full' }));
        return;
      }
      let result;
      try {
        result = await runRealtimeOpenClawTurn({ ...payload, processing: normalizeRealtimeProcessingPayload(payload), text: gate.text });
      } finally {
        decrementRealtimeQueue(payload.sessionToken);
      }
      res.writeHead(result.ok ? 200 : (result.cancelled ? 409 : 400), { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ...result, queue: { pending: realtimeQueueCount(payload.sessionToken), max: MAX_REALTIME_PENDING_TURNS } }));
      return;
    }

    if (req.method === 'POST' && urlPath === `${BASE_PATH}/realtime/analyze-attachment`) {
      const body = await readRequestBody(req, Number(process.env.VOICECLAW_ATTACHMENT_MAX_BODY_BYTES || 30_000_000));
      let payload;
      try { payload = JSON.parse(body || '{}'); } catch { payload = {}; }
      const sessionToken = payload.sessionToken || req.headers['x-voice-session-token'] || `attachment-${Date.now().toString(36)}`;
      try {
        const result = await runRealtimeAttachmentAnalysis({
          text: payload.text || '',
          sessionToken,
          urgency: payload.urgency || 'normal',
          processing: normalizeRealtimeProcessingPayload(payload),
          attachments: Array.isArray(payload.attachments) ? payload.attachments : [],
        });
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(result));
      } catch (err) {
        await appendRealtimeLog({ kind: 'attachment_analysis_error', sessionToken: sanitizeRealtimeSessionToken(sessionToken), error: err.message });
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: false, error: err.message || 'Attachment analysis failed.' }));
      }
      return;
    }

    if (req.method === 'POST' && urlPath === `${BASE_PATH}/realtime/cancel`) {
      const body = await readRequestBody(req, 50_000).catch(() => '{}');
      let payload;
      try { payload = JSON.parse(body || '{}'); } catch { payload = {}; }
      rememberRealtimeCancel(payload.sessionToken, payload.turnId || '');
      if (payload.clearQueue) realtimePendingCounts.delete(sanitizeRealtimeSessionToken(payload.sessionToken));
      const cancelled = cancelRealtimeTurn(payload.sessionToken, payload.reason || 'client cancel', payload.turnId || '', { force: !!payload.force });
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true, cancelled }));
      return;
    }

    if (req.method === 'POST' && urlPath === `${BASE_PATH}/realtime/disconnect`) {
      const body = await readRequestBody(req, 50_000).catch(() => '{}');
      let payload;
      try { payload = JSON.parse(body || '{}'); } catch { payload = {}; }
      const key = sanitizeRealtimeSessionToken(payload.sessionToken || '');
      const reason = payload.reason || 'client disconnect';
      const cancelActive = payload.cancelActive !== false;
      const closeSideband = payload.closeSideband !== false;
      const clearQueue = payload.clearQueue !== false;
      const cancelled = cancelActive ? cancelRealtimeTurn(key, reason, '', { force: true }) : false;
      if (cancelActive && clearQueue) realtimePendingCounts.delete(key);
      const sidebandClosed = closeSideband ? closeRealtimeSideband(key, reason, { clearSession: cancelActive, clearQueue: cancelActive && clearQueue }) : false;
      await appendRealtimeLog({ kind: 'realtime_session_disconnected', sessionToken: key, reason, cancelActive, closeSideband, clearQueue, cancelled, sidebandClosed, activePreserved: !cancelActive, transportState: payload.transportState || '', clientState: payload.clientState || '' });
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true, cancelled, sidebandClosed, activePreserved: !cancelActive }));
      return;
    }


    if (req.method === 'GET' && urlPath === `${BASE_PATH}/realtime/status`) {
      const url = new URL(req.url, `http://localhost:${PORT}`);
      const sessionToken = url.searchParams.get('sessionToken') || req.headers['x-voice-session-token'] || '';
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true, ...bridgeStatusSnapshot(sessionToken) }));
      return;
    }

    if (req.method === 'GET' && urlPath === `${BASE_PATH}/realtime/auth/status`) {
      const url = new URL(req.url, `http://localhost:${PORT}`);
      const probe = ['1', 'true', 'yes'].includes(String(url.searchParams.get('probe') || '').toLowerCase());
      const model = String(url.searchParams.get('model') || REALTIME_MODEL).trim() || REALTIME_MODEL;
      const voice = String(url.searchParams.get('voice') || REALTIME_VOICE).trim() || REALTIME_VOICE;
      const status = await buildRealtimeAuthStatus({
        req,
        apiKey: openAIKeyForRealtimeRequest(req),
        probe,
        model,
        voice,
      });
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(status));
      return;
    }

    if (req.method === 'POST' && urlPath === `${BASE_PATH}/realtime/watch-client-secret`) {
      const body = await readRequestBody(req, 200_000).catch(() => '{}');
      let payload;
      try { payload = JSON.parse(body || '{}'); } catch { payload = {}; }
      const routeMode = ['direct', 'instant', 'gpt55-direct', 'openclaw', 'hermes'].includes(String(payload.routeMode || '').toLowerCase())
        ? String(payload.routeMode || '').toLowerCase()
        : 'direct';
      const { session } = watchRealtimeSessionConfig({
        routeMode,
        model: payload.model || REALTIME_MODEL,
        voice: payload.voice || REALTIME_VOICE,
        sessionToken: payload.sessionToken || req.headers['x-voice-session-token'] || '',
      });
      try {
        const bearer = await mintWatchRealtimeBearer({
          req,
          session,
          apiKey: openAIKeyForRealtimeRequest(req),
        });
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          ok: true,
          bearer: bearer.bearer,
          expiresAt: bearer.expiresAt,
          source: bearer.source,
          authPreference: bearer.preferences?.mode,
          fallbackToAPIKey: bearer.preferences?.fallbackToAPIKey,
          oauthFallbackError: bearer.oauthError || '',
        }));
      } catch (error) {
        res.writeHead(503, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: false, error: error?.message || String(error), auth: realtimeAuthPreferences(req) }));
      }
      return;
    }

    if (req.method === 'POST' && urlPath === `${BASE_PATH}/realtime/watch-turn/start`) {
      const body = await readRequestBody(req, Number(process.env.WATCH_REALTIME_MAX_BODY_BYTES || 48_000_000));
      let payload;
      try { payload = JSON.parse(body || '{}'); } catch { payload = {}; }
      try {
        const jobID = startWatchRealtimeJob({ req, payload });
        res.writeHead(202, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true, jobID, status: 'running' }));
      } catch (error) {
        await appendRealtimeLog({ kind: 'watch_realtime_job_start_error', error: error?.message || String(error) });
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: false, error: error?.message || String(error) }));
      }
      return;
    }

    if (req.method === 'POST' && urlPath === `${BASE_PATH}/realtime/watch-turn/start-file`) {
      try {
        const body = await readRequestBuffer(req, Number(process.env.WATCH_REALTIME_MAX_MULTIPART_BYTES || 96_000_000));
        const payload = watchRealtimePayloadFromMultipart(body, req.headers['content-type'] || '');
        const jobID = startWatchRealtimeJob({ req, payload });
        res.writeHead(202, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true, jobID, status: 'running', transport: 'multipart-file' }));
      } catch (error) {
        await appendRealtimeLog({ kind: 'watch_realtime_job_start_file_error', error: error?.message || String(error) });
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: false, error: error?.message || String(error) }));
      }
      return;
    }

    if (req.method === 'POST' && urlPath === `${BASE_PATH}/realtime/watch-turn/cancel`) {
      const body = await readRequestBody(req, 128_000);
      let payload;
      try { payload = JSON.parse(body || '{}'); } catch { payload = {}; }
      try {
        const result = cancelWatchRealtimeJob({
          jobID: payload.jobID || payload.jobId || '',
          sessionToken: payload.sessionToken || req.headers['x-voice-session-token'] || '',
          turnId: payload.turnId || '',
          reason: payload.reason || 'watch requested cancel',
        });
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(result));
      } catch (error) {
        await appendRealtimeLog({ kind: 'watch_realtime_cancel_error', error: error?.message || String(error) });
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: false, error: error?.message || String(error) }));
      }
      return;
    }

    if (req.method === 'GET' && urlPath === `${BASE_PATH}/realtime/watch-turn/result`) {
      cleanupWatchRealtimeJobs();
      const url = new URL(req.url, `http://localhost:${PORT}`);
      const jobID = url.searchParams.get('jobID') || url.searchParams.get('jobId') || '';
      const job = watchRealtimeJobs.get(jobID);
      if (!job) {
        res.writeHead(404, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: false, status: 'missing', error: 'Watch Realtime job was not found.' }));
        return;
      }
      if (job.status === 'done') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true, status: 'done', result: job.result }));
        return;
      }
      if (job.status === 'error') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: false, status: 'error', error: job.error || 'Watch Realtime job failed.' }));
        return;
      }
      if (job.status === 'cancelled') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: false, status: 'cancelled', error: job.error || 'Watch Realtime job was cancelled.' }));
        return;
      }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true, status: job.status || 'running' }));
      return;
    }

    if (req.method === 'POST' && urlPath === `${BASE_PATH}/realtime/watch-turn`) {
      const body = await readRequestBody(req, Number(process.env.WATCH_REALTIME_MAX_BODY_BYTES || 48_000_000));
      let payload;
      try { payload = JSON.parse(body || '{}'); } catch { payload = {}; }
      try {
        const result = await runWatchRealtimeTurn({ req, payload });
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(result));
      } catch (error) {
        await appendRealtimeLog({ kind: 'watch_realtime_turn_error', error: error?.message || String(error) });
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: false, error: error?.message || String(error) }));
      }
      return;
    }

    if (req.method === 'POST' && urlPath === `${BASE_PATH}/realtime/watch-turn-file`) {
      try {
        const body = await readRequestBuffer(req, Number(process.env.WATCH_REALTIME_MAX_MULTIPART_BYTES || 96_000_000));
        const payload = watchRealtimePayloadFromMultipart(body, req.headers['content-type'] || '');
        const result = await runWatchRealtimeTurn({ req, payload });
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ...result, transport: 'multipart-file' }));
      } catch (error) {
        await appendRealtimeLog({ kind: 'watch_realtime_turn_file_error', error: error?.message || String(error) });
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: false, error: error?.message || String(error) }));
      }
      return;
    }

    if (req.method === 'POST' && urlPath === `${BASE_PATH}/realtime/session`) {
      const routeMode = realtimeRoutingMode(req);
      const apiKey = openAIKeyForRealtimeRequest(req);
      const clientPlatform = String(req.headers['x-voiceclaw-client-platform'] || '').trim().toLowerCase();

      const sessionToken = req.headers['x-voice-session-token'] || `browser-${Date.now().toString(36)}`;
      const options = realtimeRequestOptions(req, routeMode, sessionToken);
      realtimeSessionConfigs.set(options.sessionToken, { ...options, sessionStartedAt: new Date().toISOString() });
      const { sdpOffer, providedSession, transport: sessionTransport } = await readRealtimeSessionRequest(req);
      const defaultRealtimeSession = {
        type: 'realtime',
        model: options.model,
        reasoning: { effort: options.realtimeReasoning },
        instructions: realtimeInstructionsForRoute(routeMode),
        audio: buildRealtimeAudioConfig(options),
      };
      const realtimeSession = providedSession || defaultRealtimeSession;
      const tools = realtimeToolsForRoute(routeMode);
      if (!providedSession) {
        realtimeSession.tools = tools;
        realtimeSession.tool_choice = tools.length ? 'auto' : 'none';
      } else {
        realtimeSession.type = realtimeSession.type || 'realtime';
        realtimeSession.model = realtimeSession.model || options.model;
        if (!realtimeSession.audio) realtimeSession.audio = buildRealtimeAudioConfig(options);
        if (!Array.isArray(realtimeSession.tools)) realtimeSession.tools = tools;
        if (!realtimeSession.tool_choice) realtimeSession.tool_choice = realtimeSession.tools.length ? 'auto' : 'none';
      }
      const fd = new FormData();
      fd.set('sdp', sdpOffer);
      fd.set('session', JSON.stringify(realtimeSession));

      let realtimeBearer;
      try {
        realtimeBearer = await resolveRealtimeBearer({
          req,
          session: realtimeSession,
          apiKey,
        });
      } catch (error) {
        realtimeSessionConfigs.set(options.sessionToken, {
          ...options,
          sessionStartedAt: new Date().toISOString(),
          authSource: 'unavailable',
          authPreferenceSource: realtimeAuthPreferences(req).source,
          realtimeAuthPreference: realtimeAuthPreferences(req).mode,
          fallbackToAPIKey: realtimeAuthPreferences(req).fallbackToAPIKey,
          oauthFallbackError: error?.message || String(error),
          clientPlatform,
          clientProvidedSession: !!providedSession,
          sessionTransport,
          upstreamOK: false,
          upstreamStatus: 503,
        });
        res.writeHead(503, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: false, error: error?.message || String(error), auth: realtimeAuthPreferences(req) }));
        return;
      }

      const usesClientSecretSignaling = realtimeBearer.source === REALTIME_AUTH_MODE_OPENCLAW_OAUTH;
      const upstream = await fetch('https://api.openai.com/v1/realtime/calls', {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${realtimeBearer.bearer}`,
          ...(usesClientSecretSignaling ? { 'Content-Type': 'application/sdp' } : {}),
        },
        body: usesClientSecretSignaling ? sdpOffer : fd,
      });
      const body = await upstream.text();
      const location = upstream.headers.get('location') || upstream.headers.get('Location') || '';
      const sidebandStarted = hasServerOwnedRealtimeTools(routeMode) && upstream.ok && location ? await startRealtimeSideband(location, sessionToken, realtimeBearer.sidebandBearer || realtimeBearer.bearer) : false;
      realtimeSessionConfigs.set(options.sessionToken, {
        ...options,
        sessionStartedAt: new Date().toISOString(),
        authSource: realtimeBearer.source,
        authPreferenceSource: realtimeBearer.preferences.source,
        realtimeAuthPreference: realtimeBearer.preferences.mode,
        fallbackToAPIKey: realtimeBearer.preferences.fallbackToAPIKey,
        oauthFallbackError: realtimeBearer.oauthError || '',
        clientPlatform,
        clientProvidedSession: !!providedSession,
        sessionTransport,
        upstreamOK: upstream.ok,
        upstreamStatus: upstream.status,
        sidebandLocationHeader: !!location,
        sidebandStarted,
      });
      if (upstream.ok) await appendRealtimeLog({ kind: 'realtime_session_created', sessionToken: sanitizeRealtimeSessionToken(sessionToken), routeMode, clientPlatform, clientProvidedSession: !!providedSession, sessionTransport, sidebandLocationHeader: !!location, sidebandStarted, authSource: realtimeBearer.source, authPreferenceSource: realtimeBearer.preferences.source, fallbackToAPIKey: realtimeBearer.preferences.fallbackToAPIKey, oauthFallbackError: realtimeBearer.oauthError || '', options: { model: options.model, voice: options.voice, noiseReduction: options.noiseReduction, captions: options.captions, turnDetection: options.turnDetection, vadSensitivity: options.vadSensitivity, realtimeReasoning: options.realtimeReasoning, transcriptionDelay: options.transcriptionDelay } });
      const headers = { 'Content-Type': upstream.ok ? 'application/sdp' : 'text/plain' };
      if (location) headers['X-OpenAI-Realtime-Location'] = 'present';
      headers['X-OpenClaw-Route'] = routeMode;
      if (sidebandStarted) headers['X-OpenClaw-Sideband'] = 'started';
      if (providedSession) headers['X-VoiceClaw-Provided-Session'] = 'used';
      headers['X-VoiceClaw-Realtime-Auth'] = realtimeBearer.source;
      headers['X-VoiceClaw-Realtime-Auth-Preference'] = realtimeBearer.preferences.mode;
      headers['X-VoiceClaw-Realtime-Auth-Fallback'] = realtimeBearer.oauthError ? 'used' : (realtimeBearer.preferences.fallbackToAPIKey ? 'enabled' : 'disabled');
      headers['X-Realtime-Captions'] = options.captions ? 'on' : 'off';
      headers['X-Realtime-Turn-Detection'] = options.turnDetection;
      headers['X-Realtime-Reasoning'] = options.realtimeReasoning;
      res.writeHead(upstream.status, headers);
      res.end(body);
      return;
    }

    if (urlPath === `${BASE_PATH}/realtime` || urlPath === `${BASE_PATH}/realtime/`) {
      res.writeHead(302, { Location: `${BASE_PATH}/realtime.html` || '/realtime.html' });
      res.end();
      return;
    }

    if (BASE_PATH) {
      if (urlPath === '/') {
        res.writeHead(302, { Location: `${BASE_PATH}/` });
        res.end();
        return;
      }
      if (!(urlPath === BASE_PATH || urlPath.startsWith(`${BASE_PATH}/`))) {
        res.writeHead(404, { 'Content-Type': 'text/plain' });
        res.end('Not found');
        return;
      }
      urlPath = urlPath.slice(BASE_PATH.length) || '/';
    }

    if (urlPath === '/' || urlPath === '/index') urlPath = '/index.html';

    const filePath = join(CLIENT_DIR, urlPath);
    // Basic path traversal guard
    if (!filePath.startsWith(CLIENT_DIR)) {
      res.writeHead(403); res.end(); return;
    }

    const fileStat = await stat(filePath).catch(() => null);
    if (!fileStat || !fileStat.isFile()) {
      res.writeHead(404, { 'Content-Type': 'text/plain' });
      res.end('Not found');
      return;
    }

    const ext = extname(filePath);
    const contentType = MIME[ext] || 'application/octet-stream';
    const body = await readFile(filePath);
    res.writeHead(200, { 'Content-Type': contentType });
    res.end(body);
  } catch (err) {
    console.error('[http]', err.message);
    res.writeHead(500); res.end();
  }
});

// ── WebSocket server ────────────────────────────────────────────────

const WS_PATH = `${BASE_PATH}/ws` || '/ws';
const wss = new WebSocketServer({ server: httpServer, path: WS_PATH });

wss.on('connection', (ws) => {
  console.log('[ws] client connected');

  // Per-session state
  const sessionId = `ws-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const session = {
    id: sessionId,
    audioChunks: [],          // collected binary audio buffers for real turns
    wakeProbeChunks: [],      // short hands-free wake probe buffers
    bargeProbeChunks: [],     // short probes while response generation/playback is active
    bargeMode: 'generation',
    collectingWakeProbe: false,
    collectingBargeProbe: false,
    wakeProbeMode: 'wake',
    wakeProbeProcessing: false,
    continuousTextBuffer: '',
    continuousLastSpeechAt: 0,
    ttsAbort: null,           // AbortController for current TTS job
    asrAbort: null,           // AbortController for current ASR job
    dialogueAbort: null,      // AbortController for current dialogue/LLM call
    processing: false,        // true while ASR+TTS pipeline is running
    turnSeq: 0,
    activeTurnId: 0,
    cancelledThroughTurnId: 0,
    processingConfig: resolveProcessingConfig({ sessionToken: `ws-${sessionId}` }),
    voiceConfig: null,
    pendingTextTurns: [],      // queued user turns captured while a prior turn is still running
    busyQueueSeq: 0,
    busyQueueEpoch: 0,
    busyAsrControllers: new Set(),
  };

  function send(obj) {
    if (ws.readyState === ws.OPEN) {
      ws.send(JSON.stringify(obj));
    }
  }

  // Cancel any in-flight TTS, dialogue, and optionally ASR
  function cancelPipeline() {
    session.cancelledThroughTurnId = Math.max(session.cancelledThroughTurnId, session.activeTurnId || session.turnSeq || 0);
    if (session.ttsAbort) {
      session.ttsAbort.abort();
      session.ttsAbort = null;
    }
    if (session.dialogueAbort) {
      session.dialogueAbort.abort();
      session.dialogueAbort = null;
    }
    if (session.asrAbort) {
      session.asrAbort.abort();
      session.asrAbort = null;
    }
    if (session.busyAsrControllers?.size) {
      for (const controller of session.busyAsrControllers) controller.abort();
      session.busyAsrControllers.clear();
    }
    session.busyQueueEpoch = (session.busyQueueEpoch || 0) + 1;
    session.processing = false;
    session.pendingTextTurns = [];
  }

  ws.on('message', async (data, isBinary) => {
    // Binary frames = audio data from client mic. A preceding control message
    // decides whether this frame belongs to a real utterance or a wake probe.
    if (isBinary) {
      if (session.collectingBargeProbe) {
        session.bargeProbeChunks.push(Buffer.from(data));
      } else if (session.collectingWakeProbe) {
        session.wakeProbeChunks.push(Buffer.from(data));
      } else {
        session.audioChunks.push(Buffer.from(data));
      }
      return;
    }

    // Text frames = JSON control messages
    let msg;
    try { msg = JSON.parse(data.toString()); } catch { return; }

    switch (msg.type) {
      case 'start_session': {
        cancelPipeline();
        session.audioChunks = [];
        session.wakeProbeChunks = [];
        session.bargeProbeChunks = [];
        session.collectingWakeProbe = false;
        session.collectingBargeProbe = false;
        session.continuousTextBuffer = '';
        session.continuousLastSpeechAt = 0;
        session.turnSeq = 0;
        session.activeTurnId = 0;
        session.cancelledThroughTurnId = 0;
        session.busyQueueSeq = 0;
        session.pendingTextTurns = [];
        session.processingConfig = resolveProcessingConfig({ ...(msg.processing || {}), sessionToken: msg.sessionToken || session.processingConfig?.sessionToken || `ws-${session.id}` });
        session.voiceConfig = await resolveVoiceConfig(msg.voice);
        session.ttsSpeed = getTtsSpeedOptions().defaultSpeed;
        if (msg.ttsSpeed) session.ttsSpeed = msg.ttsSpeed;
        send({ type: 'processing', processing: session.processingConfig });
        send({
          type: 'voice',
          voice: {
            id: session.voiceConfig.id,
            label: session.voiceConfig.label,
            engine: session.voiceConfig.engine,
            fallbackUsed: session.voiceConfig.fallbackUsed,
            requested: session.voiceConfig.requested,
          }
        });
        send({ type: 'status', status: 'ready' });
        break;
      }

      case 'config_update': {
        session.processingConfig = resolveProcessingConfig({ ...(msg.processing || {}), sessionToken: msg.sessionToken || session.processingConfig?.sessionToken || `ws-${session.id}` });
        session.voiceConfig = await resolveVoiceConfig(msg.voice || session.voiceConfig?.id);
        if (msg.ttsSpeed) session.ttsSpeed = msg.ttsSpeed;
        send({ type: 'processing', processing: session.processingConfig });
        send({
          type: 'voice',
          voice: {
            id: session.voiceConfig.id,
            label: session.voiceConfig.label,
            engine: session.voiceConfig.engine,
            fallbackUsed: session.voiceConfig.fallbackUsed,
            requested: session.voiceConfig.requested,
          }
        });
        break;
      }

      case 'wake_probe_start':
        if (session.processing || session.wakeProbeProcessing) break;
        session.wakeProbeChunks = [];
        session.wakeProbeMode = msg.mode === 'continuous' ? 'continuous' : 'wake';
        session.collectingWakeProbe = true;
        break;

      case 'wake_probe_end':
        session.collectingWakeProbe = false;
        if (msg.mode === 'continuous') session.wakeProbeMode = 'continuous';
        if (session.wakeProbeChunks.length === 0 || session.processing || session.wakeProbeProcessing) break;
        processWakeProbe(session, ws, send).catch((err) => {
          console.error('[wake] probe failed:', err.message);
        });
        break;

      case 'barge_probe_start':
        session.bargeProbeChunks = [];
        session.bargeMode = msg.mode === 'playback' ? 'playback' : 'generation';
        session.collectingBargeProbe = true;
        break;

      case 'barge_probe_end':
        session.collectingBargeProbe = false;
        if (msg.mode === 'playback') session.bargeMode = 'playback';
        if (session.bargeProbeChunks.length === 0) break;
        processBargeProbe(session, ws, send, cancelPipeline).catch((err) => {
          console.error('[barge] probe failed:', err.message);
        });
        break;

      case 'audio_end':
        // Client finished recording an utterance — process it
        session.collectingWakeProbe = false;
        if (session.audioChunks.length === 0) {
          send({ type: 'error', message: 'No audio received' });
          break;
        }
        await processUtterance(session, ws, send);
        break;

      case 'client_event':
        console.log(`[client] event=${msg.event || 'unknown'} level=${msg.level ?? ''}`);
        break;

      case 'interrupt':
        // Barge-in: kill current TTS immediately
        console.log('[ws] interrupt received');
        cancelPipeline();
        send({ type: 'interrupted' });
        break;

      default:
        break;
    }
  });

  ws.on('close', () => {
    console.log('[ws] client disconnected');
    cancelPipeline();
    clearHistory(sessionId);
  });

  ws.on('error', (err) => {
    console.error('[ws] error:', err.message);
    cancelPipeline();
  });
});

// ── Pipeline: audio → ASR → dialogue → TTS → stream back ───────────

function stripWakePrefixFromTurn(text = '') {
  const original = String(text || '').trim();
  if (!original) return original;

  // SpeechRecognition/Whisper often includes the wake word at the front of the
  // actual turn (for example: “Hey, what time is it?”). The wake word is UI
  // control, not useful user content, so strip only a leading wake prefix and
  // leave the rest of the utterance intact.
  return stripWakePrefixText(original) || original;
}

function stripWakePrefixText(text = '') {
  const original = String(text || '').trim();
  if (!original) return '';
  return original
    .replace(/^(?:hey|hay|heyy)(?:\s+(?:open\s*claw|open\s*cloud|opencloud|openclaw|open\s*claws|open\s*clause|open\s*claude))?[\s,;:\-–—.!?]*/i, '')
    .replace(/^(?:open\s*claw|open\s*cloud|opencloud|openclaw|open\s*claws|open\s*clause|open\s*claude)[\s,;:\-–—.!?]+/i, '')
    .trim();
}

function isWakeRemainderTurn(text = '') {
  const normalized = String(text || '').trim().toLowerCase().replace(/[^a-z0-9\s?!.]/g, ' ').replace(/\s+/g, ' ');
  if (!normalized || normalized === '[blank_audio]') return false;
  if (['hey', 'hay', 'heyy', 'openclaw', 'open claw', 'open cloud', 'open claude'].includes(normalized)) return false;
  return normalized.length >= 2;
}

function parseWakeTurn(text = '') {
  const original = String(text || '').trim();
  const matched = detectWakePhrase(original);
  if (!matched) return { matched: false, turnText: '', stripped: '' };
  const stripped = stripWakePrefixText(original);
  return { matched: true, turnText: isWakeRemainderTurn(stripped) ? stripped : '', stripped };
}

function beginTurn(session) {
  const turnId = ++session.turnSeq;
  session.activeTurnId = turnId;
  return turnId;
}

function isTurnStale(session, turnId) {
  return turnId <= (session.cancelledThroughTurnId || 0) || turnId !== session.activeTurnId;
}

async function processTranscribedUtterance(session, ws, send, text, turnStart = Date.now(), turnId = beginTurn(session), options = {}) {
  const cleanedText = stripWakePrefixFromTurn(text);
  if (!cleanedText || cleanedText.trim() === '' || cleanedText.trim() === '[BLANK_AUDIO]') {
    send({ type: 'transcript', text: '(no speech detected)', final: true });
    return;
  }
  const gate = actionability(cleanedText, { allowWake: false, allowShortCommand: true, context: options.queued ? 'queued' : 'turn' });
  if (!gate.actionable) {
    console.log(`[turn] filtered_non_actionable reason=${gate.reason} text=${JSON.stringify(cleanedText.slice(0, 80))}`);
    send({ type: 'transcript', text: gate.reason === 'noise-only' ? '(background noise ignored)' : '(unclear audio ignored)', rawText: text, final: true, filtered: true, reason: gate.reason, turnId });
    send({ type: 'status', status: 'ready' });
    return;
  }

  if (isTurnStale(session, turnId)) {
    console.log(`[turn] stale_before_transcript turn=${turnId} active=${session.activeTurnId} cancelledThrough=${session.cancelledThroughTurnId}`);
    return;
  }
  const routedText = gate.text || cleanedText;
  if (!options.suppressTranscript) send({ type: 'transcript', text: routedText, rawText: text, final: true, turnId, queued: !!options.queued });

  const dialogueController = new AbortController();
  session.dialogueAbort = dialogueController;

  send({ type: 'status', status: 'thinking' });
  const dialogueStart = Date.now();
  const reply = await generateReply(routedText, {
    sessionId: session.id,
    signal: dialogueController.signal,
    processing: session.processingConfig,
  });
  console.log(`[turn] dialogue_ms=${Date.now() - dialogueStart} turn=${turnId}`);
  session.dialogueAbort = null;

  if (isTurnStale(session, turnId)) {
    console.log(`[turn] stale_after_dialogue turn=${turnId} active=${session.activeTurnId} cancelledThrough=${session.cancelledThroughTurnId}`);
    return;
  }
  if (!reply) return;
  send({ type: 'reply', text: reply, turnId });

  const ttsController = new AbortController();
  session.ttsAbort = ttsController;

  if (isTurnStale(session, turnId)) {
    console.log(`[turn] stale_before_tts turn=${turnId} active=${session.activeTurnId} cancelledThrough=${session.cancelledThroughTurnId}`);
    return;
  }
  send({ type: 'tts_start', turnId });
  const ttsStart = Date.now();
  const wavBuf = await synthesize(reply, {
    signal: ttsController.signal,
    voice: session.voiceConfig?.id,
    speed: session.ttsSpeed,
  });
  console.log(`[turn] tts_ms=${Date.now() - ttsStart} audio_bytes=${wavBuf.length} turn=${turnId}`);
  session.ttsAbort = null;

  if (isTurnStale(session, turnId)) {
    console.log(`[turn] stale_after_tts turn=${turnId} active=${session.activeTurnId} cancelledThrough=${session.cancelledThroughTurnId}`);
    return;
  }
  if (ws.readyState === ws.OPEN) {
    ws.send(wavBuf);
  }
  send({ type: 'tts_end', turnId });
  console.log(`[turn] total_ms=${Date.now() - turnStart} turn=${turnId}`);
}

function pendingReadyCount(session) {
  return session.pendingTextTurns.filter((turn) => turn.ready && !turn.dropped).length;
}

async function queueBusyUtterance(session, ws, send, rawAudio) {
  if (!rawAudio?.length) return;
  const queuedAt = Date.now();
  const epoch = session.busyQueueEpoch || 0;
  const controller = new AbortController();
  const slot = {
    seq: ++session.busyQueueSeq,
    queuedAt,
    ready: false,
    dropped: false,
    text: '',
    rawText: '',
    epoch,
    controller,
  };
  if (session.pendingTextTurns.length >= MAX_CLASSIC_PENDING_TURNS) {
    send({ type: 'busy', message: `OpenClaw queue is full (${MAX_CLASSIC_PENDING_TURNS} waiting). Say stop or wait a moment.` });
    return;
  }
  session.pendingTextTurns.push(slot);
  session.busyAsrControllers.add(controller);

  try {
    send({ type: 'status', status: 'transcribing' });
    const { text } = await transcribe(rawAudio, { signal: controller.signal });
    session.busyAsrControllers.delete(controller);

    if (slot.epoch !== session.busyQueueEpoch || !session.pendingTextTurns.includes(slot)) return;

    const cleanedText = stripWakePrefixFromTurn(text);
    const gate = actionability(cleanedText, { allowWake: false, allowShortCommand: true, context: 'busy-queue' });
    if (!cleanedText || cleanedText.trim() === '' || cleanedText.trim() === '[BLANK_AUDIO]' || !gate.actionable) {
      slot.dropped = true;
      console.log(`[turn] dropped queued non-actionable reason=${gate.reason || 'blank'} text=${JSON.stringify((cleanedText || '').slice(0, 80))}`);
      setTimeout(() => drainPendingTextTurns(session, ws, send).catch((err) => console.error('[queue-drain]', err.message)), 0);
      return;
    }

    slot.text = gate.text || cleanedText;
    slot.rawText = text;
    slot.ready = true;
    send({ type: 'transcript', text: cleanedText, rawText: text, final: true, queued: true });
    send({ type: 'busy', message: `Queued while OpenClaw finishes the current turn (${pendingReadyCount(session)} waiting).` });
    send({ type: 'status', status: 'thinking' });
    console.log(`[turn] queued busy utterance seq=${slot.seq} ready=${pendingReadyCount(session)} text=${JSON.stringify(cleanedText.slice(0, 80))}`);
    if (!session.processing) {
      drainPendingTextTurns(session, ws, send).catch((err) => console.error('[queue-drain]', err.message));
    }
  } catch (err) {
    session.busyAsrControllers.delete(controller);
    if (slot.epoch === session.busyQueueEpoch && session.pendingTextTurns.includes(slot)) {
      slot.dropped = true;
      setTimeout(() => drainPendingTextTurns(session, ws, send).catch((drainErr) => console.error('[queue-drain]', drainErr.message)), 0);
    }
    if (err.message !== 'aborted') console.error('[queue-busy]', err.message);
  }
}

async function drainPendingTextTurns(session, ws, send) {
  while (session.pendingTextTurns[0]?.dropped) session.pendingTextTurns.shift();
  if (session.processing || !session.pendingTextTurns.length) return;
  const next = session.pendingTextTurns[0];
  if (!next.ready) return;
  session.pendingTextTurns.shift();
  const turnId = beginTurn(session);
  session.processing = true;
  try {
    send({ type: 'queued_turn_started', text: next.text, turnId, remaining: pendingReadyCount(session) });
    await processTranscribedUtterance(session, ws, send, next.text, next.queuedAt || Date.now(), turnId, { queued: true, suppressTranscript: true });
  } catch (err) {
    if (err.message !== 'aborted') console.error('[queue-drain]', err.message);
  } finally {
    if (session.activeTurnId === turnId) session.processing = false;
    session.dialogueAbort = null;
    session.ttsAbort = null;
    session.asrAbort = null;
  }
  while (session.pendingTextTurns[0]?.dropped) session.pendingTextTurns.shift();
  if (session.pendingTextTurns.length && !session.processing && session.pendingTextTurns[0].ready) {
    setTimeout(() => drainPendingTextTurns(session, ws, send).catch((err) => console.error('[queue-drain]', err.message)), 20);
  }
}

async function processUtterance(session, ws, send) {
  if (session.processing) {
    const busyAudio = Buffer.concat(session.audioChunks);
    session.audioChunks = [];
    queueBusyUtterance(session, ws, send, busyAudio).catch((err) => console.error('[queue-busy]', err.message));
    return;
  }
  session.processing = true;
  const turnId = beginTurn(session);
  const turnStart = Date.now();

  // Combine all audio chunks into a single WAV buffer
  const rawAudio = Buffer.concat(session.audioChunks);
  const energy = shouldSkipAudio(rawAudio, MIN_TURN_RMS);
  console.log(`[turn] start session=${session.id} turn=${turnId} bytes=${rawAudio.length} rms=${Math.round(energy.rms)} peak=${energy.peak}`);
  session.audioChunks = [];
  if (energy.skip) {
    console.log(`[turn] skipped low-energy audio turn=${turnId} rms=${Math.round(energy.rms)} threshold=${energy.threshold}`);
    send({ type: 'transcript', text: '(blank audio ignored)', final: true, filtered: true, reason: 'low-energy', turnId });
    send({ type: 'status', status: 'ready' });
    session.processing = false;
    return;
  }

  const asrController = new AbortController();
  session.asrAbort = asrController;

  try {
    // 1. ASR
    send({ type: 'status', status: 'transcribing' });
    const asrStart = Date.now();
    const { text } = await transcribe(rawAudio, { signal: asrController.signal });
    console.log(`[turn] asr_ms=${Date.now() - asrStart} turn=${turnId} text=${JSON.stringify((text || '').slice(0, 80))}`);
    session.asrAbort = null;

    if (isTurnStale(session, turnId)) {
      console.log(`[turn] stale_after_asr turn=${turnId} active=${session.activeTurnId} cancelledThrough=${session.cancelledThroughTurnId}`);
      return;
    }
    await processTranscribedUtterance(session, ws, send, text, turnStart, turnId);

  } catch (err) {
    if (err.message === 'aborted') {
      // Expected from interrupt — already handled
    } else {
      console.error('[pipeline]', err.message);
      send({ type: 'error', message: 'Processing failed' });
    }
  } finally {
    if (session.activeTurnId === turnId) session.processing = false;
    session.asrAbort = null;
    session.dialogueAbort = null;
    session.ttsAbort = null;
    if (!session.processing) {
      drainPendingTextTurns(session, ws, send).catch((err) => console.error('[queue-drain]', err.message));
    }
  }
}


function detectWakePhrase(text = '') {
  const normalized = text.toLowerCase().replace(/[^a-z\s]/g, ' ').replace(/\s+/g, ' ').trim();
  if (!normalized) return false;

  const wakeWords = ['hey', 'hay', 'heyy'];
  const hasHey = wakeWords.some((word) => normalized === word
    || normalized.startsWith(`${word} `)
    || normalized.includes(` ${word} `));
  const openClawVariants = [
    'openclaw',
    'open claw',
    'open cloud',
    'open clouds',
    'open club',
    'open cloth',
    'open claud',
    'open claude',
    'open clause',
    'open the claw',
    'open the cloud',
    'open the ball',
    'open to all',
    'welcome claw',
    'welcome cloud',
  ];

  if (openClawVariants.some((phrase) => normalized.includes(phrase))) return true;
  return hasHey;
}


function isContinuousSpeechTurn(text = '') {
  const normalized = text.toLowerCase().replace(/[^a-z0-9\s?!.]/g, ' ').replace(/\s+/g, ' ').trim();
  if (!normalized || normalized === '[blank_audio]') return false;
  const noiseOnly = new Set([
    'you', 'thank you', 'thanks', 'uh', 'um', 'hmm', 'keyboard', 'typing',
    'keyboard clacking', 'keyboard clicking', 'typing sounds'
  ]);
  if (noiseOnly.has(normalized)) return false;
  const words = normalized.split(/\s+/).filter(Boolean);
  if (words.length >= 3) return true;
  if (words.length >= 2 && /[?!.]$/.test(text.trim())) return true;
  return false;
}


function absorbContinuousSpeech(session, text = '') {
  const trimmed = String(text || '').trim();
  const normalized = trimmed.toLowerCase().replace(/[^a-z0-9\s?!.]/g, ' ').replace(/\s+/g, ' ').trim();
  if (!normalized || normalized === '[blank_audio]') return { matched: false, text: '', buffered: session.continuousTextBuffer || '' };
  const noiseOnly = new Set([
    'you', 'thank you', 'thanks', 'uh', 'um', 'hmm', 'keyboard', 'typing',
    'keyboard clacking', 'keyboard clicking', 'typing sounds'
  ]);
  if (noiseOnly.has(normalized)) return { matched: false, text: '', buffered: session.continuousTextBuffer || '' };

  const now = Date.now();
  const previous = (now - (session.continuousLastSpeechAt || 0)) < 2500 ? session.continuousTextBuffer : '';
  const combined = `${previous} ${trimmed}`.trim();
  session.continuousTextBuffer = combined;
  session.continuousLastSpeechAt = now;

  if (isContinuousSpeechTurn(combined)) {
    session.continuousTextBuffer = '';
    session.continuousLastSpeechAt = 0;
    return { matched: true, text: combined, buffered: combined };
  }
  return { matched: false, text: '', buffered: combined };
}


function parseBargeIn(text = '', mode = 'generation') {
  const original = String(text || '').trim();
  const normalized = original.toLowerCase().replace(/[^a-z0-9\s]/g, ' ').replace(/\s+/g, ' ').trim();
  if (!normalized) return { matched: false, remainder: '' };

  // During playback the speaker audio can leak back into the mic, so only
  // explicit human barge-in phrases are allowed. Broader phrases like “sorry”
  // or “stop” are reserved for generation, where there is no TTS echo.
  const playbackPhrases = [
    'hold on a second',
    'hold on a sec',
    'hold on',
    'hey wait',
    'wait'
  ];
  const generationPhrases = [
    ...playbackPhrases,
    'one second',
    'one sec',
    'sorry',
    'stop',
    'pause'
  ];
  const phrases = mode === 'playback' ? playbackPhrases : generationPhrases;

  for (const phrase of phrases) {
    const idx = normalized.indexOf(phrase);
    if (idx === -1) continue;
    const after = normalized.slice(idx + phrase.length).trim();
    return { matched: true, phrase, remainder: after };
  }
  return { matched: false, remainder: '' };
}

async function processBargeProbe(session, ws, send, cancelPipeline) {
  const rawAudio = Buffer.concat(session.bargeProbeChunks);
  session.bargeProbeChunks = [];
  if (!rawAudio.length) return;
  const energy = shouldSkipAudio(rawAudio, MIN_PROBE_RMS);
  if (energy.skip) {
    console.log(`[barge] skipped low-energy probe rms=${Math.round(energy.rms)} threshold=${energy.threshold}`);
    send({ type: 'barge_probe_result', matched: false, text: '', reason: 'low-energy' });
    return;
  }

  const controller = new AbortController();
  const started = Date.now();
  try {
    const { text } = await transcribe(rawAudio, { signal: controller.signal });
    const trimmed = String(text || '').trim();
    const parsed = parseBargeIn(trimmed, session.bargeMode);
    console.log(`[barge] mode=${session.bargeMode} probe_ms=${Date.now() - started} matched=${parsed.matched} phrase=${JSON.stringify(parsed.phrase || '')} remainder=${JSON.stringify(parsed.remainder || '')} text=${JSON.stringify(trimmed.slice(0, 120))}`);
    send({ type: 'barge_probe_result', matched: parsed.matched, text: trimmed, remainder: parsed.remainder || '' });
    if (parsed.matched) {
      cancelPipeline();
      send({ type: 'interrupted', reason: 'voice-barge-in', text: trimmed, remainder: parsed.remainder || '' });
      if (parsed.remainder) {
        setTimeout(async () => {
          if (session.processing) return;
          session.processing = true;
          try {
            const remainderTurnId = beginTurn(session);
            send({ type: 'barge_remainder_started', text: parsed.remainder, turnId: remainderTurnId });
            await processTranscribedUtterance(session, ws, send, parsed.remainder, started, remainderTurnId);
          } catch (err) {
            if (err.message !== 'aborted') console.error('[barge-remainder]', err.message);
          } finally {
            if (!session.activeTurnId || session.activeTurnId <= session.cancelledThroughTurnId) session.processing = false;
            session.dialogueAbort = null;
            session.ttsAbort = null;
            session.asrAbort = null;
          }
        }, 150);
      }
    }
  } catch (err) {
    if (err.message !== 'aborted') console.error('[barge]', err.message);
  }
}

async function processWakeProbe(session, ws, send) {
  if (session.wakeProbeProcessing) return;
  session.wakeProbeProcessing = true;
  const rawAudio = Buffer.concat(session.wakeProbeChunks);
  session.wakeProbeChunks = [];
  if (!rawAudio.length) {
    session.wakeProbeProcessing = false;
    return;
  }
  const energy = shouldSkipAudio(rawAudio, MIN_PROBE_RMS);
  if (energy.skip) {
    console.log(`[wake] skipped low-energy probe rms=${Math.round(energy.rms)} threshold=${energy.threshold}`);
    send({ type: 'wake_probe_result', matched: false, text: '', rawText: '', reason: 'low-energy', mode: session.wakeProbeMode });
    session.wakeProbeProcessing = false;
    return;
  }

  const controller = new AbortController();
  const started = Date.now();
  try {
    const { text } = await transcribe(rawAudio, { signal: controller.signal });
    const trimmed = String(text || '').trim();
    let matched;
    let turnText = trimmed;
    let buffered = '';
    let wakeRemainder = '';
    if (session.wakeProbeMode === 'continuous') {
      const absorbed = absorbContinuousSpeech(session, trimmed);
      matched = absorbed.matched;
      turnText = absorbed.text || trimmed;
      buffered = absorbed.buffered || '';
    } else {
      const parsedWake = parseWakeTurn(trimmed);
      matched = parsedWake.matched;
      wakeRemainder = parsedWake.turnText || '';
      turnText = wakeRemainder || trimmed;
    }
    console.log(`[wake] mode=${session.wakeProbeMode} probe_ms=${Date.now() - started} matched=${matched} text=${JSON.stringify(trimmed.slice(0, 80))} remainder=${JSON.stringify(wakeRemainder.slice(0, 120))} buffered=${JSON.stringify(buffered.slice(0, 120))}`);
    send({ type: 'wake_probe_result', matched, text: turnText, rawText: trimmed, remainder: wakeRemainder, buffered, mode: session.wakeProbeMode });
    if (matched && session.wakeProbeMode === 'wake' && wakeRemainder) {
      if (session.processing) {
        if (session.pendingTextTurns.length >= MAX_CLASSIC_PENDING_TURNS) {
          send({ type: 'busy', message: `OpenClaw queue is full (${MAX_CLASSIC_PENDING_TURNS} waiting). Say stop or wait a moment.` });
          return;
        }
        session.pendingTextTurns.push({ text: wakeRemainder, queuedAt: started, ready: true, dropped: false });
        send({ type: 'busy', message: `Queued wake turn while OpenClaw finishes the current turn (${pendingReadyCount(session)} waiting).` });
        return;
      }
      session.processing = true;
      const turnId = beginTurn(session);
      try {
        send({ type: 'wake_turn_started', text: wakeRemainder, rawText: trimmed, turnId });
        await processTranscribedUtterance(session, ws, send, wakeRemainder, started, turnId);
      } finally {
        if (session.activeTurnId === turnId) session.processing = false;
        session.dialogueAbort = null;
        session.ttsAbort = null;
        session.asrAbort = null;
        if (!session.processing) {
          drainPendingTextTurns(session, ws, send).catch((err) => console.error('[queue-drain]', err.message));
        }
      }
      return;
    }
    if (matched && session.wakeProbeMode === 'continuous') {
      if (session.processing) {
        if (session.pendingTextTurns.length >= MAX_CLASSIC_PENDING_TURNS) {
          send({ type: 'busy', message: `OpenClaw queue is full (${MAX_CLASSIC_PENDING_TURNS} waiting). Say stop or wait a moment.` });
          return;
        }
        session.pendingTextTurns.push({ text: turnText, queuedAt: started, ready: true, dropped: false });
        send({ type: 'busy', message: `Queued while OpenClaw finishes the current turn (${pendingReadyCount(session)} waiting).` });
        return;
      }
      session.processing = true;
      const turnId = beginTurn(session);
      try {
        send({ type: 'continuous_turn_started', text: turnText, turnId });
        await processTranscribedUtterance(session, ws, send, turnText, started, turnId);
      } finally {
        if (session.activeTurnId === turnId) session.processing = false;
        session.dialogueAbort = null;
        session.ttsAbort = null;
        session.asrAbort = null;
        if (!session.processing) {
          drainPendingTextTurns(session, ws, send).catch((err) => console.error('[queue-drain]', err.message));
        }
      }
      return;
    }
    if (matched) send({ type: 'wake_detected', text: trimmed, mode: session.wakeProbeMode });
  } catch (err) {
    if (err.message !== 'aborted') console.error('[wake]', err.message);
  } finally {
    session.wakeProbeProcessing = false;
  }
}

// ── Start ───────────────────────────────────────────────────────────

httpServer.listen(PORT, BIND_HOST, () => {
  console.log(`[voice-bridge] listening on http://${BIND_HOST}:${PORT}${BASE_PATH || '/'}`);
  console.log(`[voice-bridge] client dir: ${CLIENT_DIR}`);
  console.log(`[voice-bridge] WebSocket endpoint: ws://localhost:${PORT}${WS_PATH}`);
  console.log(`[voice-bridge] health endpoint: http://localhost:${PORT}/healthz`);
  console.log(`[voice-bridge] wake phrase: ${JSON.stringify(WAKE_PHRASE)}`);
});
