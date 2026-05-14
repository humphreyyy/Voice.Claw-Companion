// Voice Bridge — Transport Server
// HTTP server + WebSocket for voice session management
// Serves client assets, handles audio upload/streaming, ASR, TTS, interrupts

import { createServer } from 'node:http';
import { timingSafeEqual } from 'node:crypto';
import { readFile, stat, mkdir, appendFile, writeFile, readdir } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import { join, extname, basename } from 'node:path';
import { homedir } from 'node:os';
import { fileURLToPath } from 'node:url';
import WebSocket, { WebSocketServer } from 'ws';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { transcribe } from './asr.js';
import { synthesize, getVoiceOptions, resolveVoiceConfig, getTtsSpeedOptions, getTtsStatus } from './tts.js';
import { generateReply, clearHistory, getProcessingOptions, resolveProcessingConfig, prewarmProcessing, steerActiveReply } from './dialogue.js';
import { describeRdFlags, rdRouteModeIds } from './rd-flags.js';
import { callOpenClawMcpTool } from './rd-mcp/openclaw-mcp-client.mjs';

const __dirname = fileURLToPath(new URL('.', import.meta.url));
const execFileAsync = promisify(execFile);
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

const REALTIME_MODEL = process.env.REALTIME_MODEL || 'gpt-realtime-2';
const REALTIME_TRANSCRIPTION_MODEL = process.env.REALTIME_TRANSCRIPTION_MODEL || 'gpt-realtime-whisper';
const REALTIME_REASONING_EFFORT = process.env.REALTIME_REASONING_EFFORT || 'high';
const REALTIME_TRANSCRIPTION_DEFAULT = !['0', 'false', 'off', 'no'].includes(String(process.env.REALTIME_TRANSCRIPTION_DEFAULT || '0').toLowerCase());
const REALTIME_TRANSCRIPTION_DELAY = process.env.REALTIME_TRANSCRIPTION_DELAY || 'low';
const REALTIME_TRANSCRIPTION_LANGUAGE = process.env.REALTIME_TRANSCRIPTION_LANGUAGE || '';
const REALTIME_TURN_DETECTION_MODE = process.env.REALTIME_TURN_DETECTION_MODE || 'semantic_vad';
const REALTIME_SEMANTIC_VAD_EAGERNESS = process.env.REALTIME_SEMANTIC_VAD_EAGERNESS || 'auto';
const REALTIME_VOICE = process.env.REALTIME_VOICE || 'marin';
const REALTIME_LOG_DIR = process.env.REALTIME_LOG_DIR || join(__dirname, '..', 'ops-node', 'logs');
const REALTIME_TRANSCRIPT_LOG = join(REALTIME_LOG_DIR, 'realtime-transcripts.jsonl');
const RD_DATA_DIR = join(__dirname, '..', 'data');
const RD_NOTES_DIR = join(__dirname, '..', 'notes');
const RD_CODEX_TASK_DIR = join(__dirname, '..', 'codex-tasks');
const RD_SCREENSHOT_DIR = join(__dirname, '..', 'screenshots');
const RD_DASHBOARD_TASKS_FILE = join(RD_DATA_DIR, 'rd-dashboard-tasks.json');
const OPENCLAW_CONFIG = process.env.OPENCLAW_CONFIG || join(homedir(), '.openclaw', 'openclaw.json');
const REALTIME_VAD_THRESHOLD = Number(process.env.REALTIME_VAD_THRESHOLD || 0.68);
const REALTIME_VAD_PREFIX_PADDING_MS = Number(process.env.REALTIME_VAD_PREFIX_PADDING_MS || 240);
const REALTIME_VAD_SILENCE_DURATION_MS = Number(process.env.REALTIME_VAD_SILENCE_DURATION_MS || 330);
const VOICECLAW_BRIDGE_TOKEN = (process.env.VOICECLAW_BRIDGE_TOKEN || process.env.OPENCLAW_GATEWAY_TOKEN || '').trim();
const VOICECLAW_BRIDGE_PASSWORD = (process.env.VOICECLAW_BRIDGE_PASSWORD || process.env.OPENCLAW_GATEWAY_PASSWORD || '').trim();

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
    || logicalPath.startsWith('/rd/');
}

function requireBridgeAuth(req, res) {
  if (hasBridgeAuth(req)) return true;

  res.writeHead(401, {
    'Content-Type': 'application/json',
    'WWW-Authenticate': 'Bearer realm="VoiceClaw Bridge"',
  });
  res.end(JSON.stringify({ ok: false, error: 'VoiceClaw Bridge authorization required' }));
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

const REALTIME_INSTRUCTIONS = process.env.REALTIME_INSTRUCTIONS || `
# Role
- You are OpenClaw's high-capability realtime intercom layer running on GPT-Realtime-2.
- You are the live voice brain for timing, interruption, audio understanding, and immediate spoken flow. OpenClaw core is the heavy tool body: memory, files, calendar, messages, browser, code runner, sessions, crons, and system checks.
- Use OpenClaw as the public product name. Do not mention internal agent names in user-facing speech.

# Routing rule: when to call OpenClaw
- For any substantive request, question, decision, reminder, memory/calendar/file/message/browser/coding/business task, or anything needing tools/current state/deeper reasoning, call the openclaw_turn tool.
- Preserve the user's request faithfully and completely in the tool text. You do not need a separate transcription model to do this: infer the text from the live audio and pass the full intent.
- If you are calling OpenClaw because no direct Realtime/MCP tool can handle the request, include that fact in the tool text and ask OpenClaw to both fulfill the request and consider whether this should become a modification of an existing local MCP tool or a future direct local MCP tool. The default heuristic is: if future repeats would be faster/directer as a local tool than by routing through OpenClaw, OpenClaw should say it is creating/staging/recommending that tool and tell the user. Also ask OpenClaw/Julian to message the Matrix room “Realtime Tool Creation” either way with the recommendation and why. If it is not a good tool candidate, OpenClaw should keep that Matrix note brief.
- Before calling openclaw_turn, say at most one brief bridge phrase, for example: "On it.", "Checking.", or "One sec." Do not explain the route, tools, architecture, plan, or why you are calling OpenClaw.
- Do not invent tool results. Never claim you checked tools, files, memory, calendar, messages, or system state unless openclaw_turn returned that result.

# Tool-call speech discipline
- When doing something, do it. Do not narrate mechanics.
- After a successful tool action, give a brief useful completion note. Do not overexplain implementation details unless asked.
- Explain if the user asked for an explanation, the tool failed, or there is a real blocker/choice.

# What you may answer directly
- Very short conversational glue only: acknowledgements, request-to-repeat, or clarification that the audio was unclear.
- Keep final spoken answers concise and natural for voice.

# Unclear or low-confidence audio
- If audio is missing, blank, likely environmental noise, or you are unsure what the user said, do not guess. Ask briefly: "Say that again?" or "I didn’t catch that."
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
- You are GPT-Realtime-2 in direct realtime intercom mode for User.
- Use your native realtime audio, reasoning, and conversation capabilities fully.
- Do not claim access to OpenClaw bridge tools, local files, memory, browser, calendars, messages, system state, or live dashboards unless those tools are explicitly supplied in the current session.
- If the user asks for OpenClaw-backed work/current system facts, say briefly that Direct mode needs the OpenClaw Bridge mode for that and continue helpfully with what you can answer directly.
- Keep spoken replies concise, natural, and high-agency. Do not narrate process; give a brief useful completion note when an action finishes.
`;

const REALTIME_DIRECT_TOOLS_INSTRUCTIONS = process.env.REALTIME_DIRECT_TOOLS_INSTRUCTIONS || `
# Role
- You are GPT-Realtime-2 in direct realtime intercom mode for User, with only lightweight Realtime-native tools supplied in this session.
- Do not claim access to OpenClaw bridge tools, local files, memory, browser, calendars, messages, system state, or live dashboards.
- If the user asks for OpenClaw-backed work/current system facts, say briefly that OpenClaw Bridge mode is required for that.

# Tools
- Use only the tools explicitly provided in this session.
- If the latest audio is silence, background noise, side conversation, or speech not addressed to you, call wait_for_user and do not speak afterward.
- If the user asks what mode/tools/status you are in, call realtime_status.
- If the user asks for fresh public web information, call the server-owned web_search function directly.
- For normal conversation, answer directly and concisely. Do not narrate process; give a brief useful completion note when an action finishes.
`;

const REALTIME_TOOLS = [
  {
    type: 'function',
    name: 'openclaw_turn',
    description: "Hand the user's full request to the local OpenClaw agent runtime. This is not a tiny helper: once invoked, OpenClaw may use its normal local tools/session authority for files, shell, browser, memory, crons, messages, subagents, coding, research, dashboards, and multi-step work, subject only to the agent's standing safety/approval rules. Returns the final answer to speak.",
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        text: { type: 'string', description: 'The exact user request to route through OpenClaw.' },
        urgency: { type: 'string', enum: ['low', 'normal', 'high'], description: 'How urgent the request seems.' }
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
        urgency: { type: 'string', enum: ['low', 'normal', 'high'], description: 'How urgent this steering update is.' }
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

const LOCAL_OPENCLAW_MCP_TOOLS = [
  {
    type: 'function',
    name: 'openclaw_status',
    description: 'Use the local OpenClaw MCP adapter to read real OpenClaw status from this machine. This is a server-owned R&D route; it does not expose localhost to OpenAI.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        includeRaw: { type: 'boolean', description: 'Include raw CLI stdout/stderr in the tool result. Default false.' }
      },
      required: []
    }
  },
  {
    type: 'function',
    name: 'openclaw_default_model',
    description: 'Use the local OpenClaw MCP adapter to read the configured default OpenClaw model from this machine.',
    parameters: { type: 'object', additionalProperties: false, properties: {}, required: [] }
  },
  {
    type: 'function',
    name: 'bridge_status',
    description: 'Report local Realtime bridge state without leaving this server.',
    parameters: { type: 'object', additionalProperties: false, properties: {}, required: [] }
  }
];

const WEB_SEARCH_REALTIME_TOOL = {
  type: 'function',
  name: 'web_search',
  description: 'Server Realtime-2 web search function. Searches the public web from the local R&D server and returns concise result titles, URLs, and snippets. This is server-owned, not an OpenAI-native hosted web_search tool and not an OpenClaw tool.',
  parameters: {
    type: 'object',
    additionalProperties: false,
    properties: {
      query: { type: 'string', description: 'Search query.' },
      count: { type: 'number', description: 'Number of results to return, 1-10. Default 5.' },
      country: { type: 'string', description: 'Optional 2-letter region/country hint.' },
      language: { type: 'string', description: 'Optional language hint, e.g. en.' }
    },
    required: ['query']
  }
};

const DIRECT_REALTIME_TOOLS = [
  WEB_SEARCH_REALTIME_TOOL,
  {
    type: 'function',
    name: 'wait_for_user',
    description: 'Call this when the latest audio is silence, background noise, side conversation, or otherwise does not need a spoken response. Do not speak after this tool call.',
    parameters: { type: 'object', additionalProperties: false, properties: {}, required: [] }
  },
  {
    type: 'function',
    name: 'realtime_status',
    description: 'Report the current direct Realtime session mode, turn detection, captions, voice, and tool-choice state. This does not access OpenClaw.',
    parameters: { type: 'object', additionalProperties: false, properties: {}, required: [] }
  }
];

const RND_MCP_TOOLS = [
  {
    type: 'function',
    name: 'workspace_arrange_apps',
    description: 'Visible R&D tool: open/focus common apps and optionally arrange their front windows into a split-screen workspace preset.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        preset: { type: 'string', enum: ['intercom_demo', 'browser_codex', 'browser_notes', 'focus_only'], description: 'Workspace arrangement preset.' },
        apps: { type: 'array', items: { type: 'string' }, description: 'Optional app names to activate, e.g. Google Chrome, Terminal, TextEdit, Codex.' }
      },
      required: []
    }
  },
  {
    type: 'function',
    name: 'screen_capture_summary',
    description: 'Visible R&D tool: capture a local screenshot and return screen summary using front app/window metadata and local OCR when available.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        includeOcr: { type: 'boolean', description: 'Run local tesseract OCR if available. Default true.' }
      },
      required: []
    }
  },
  {
    type: 'function',
    name: 'project_note_update',
    description: 'Productivity R&D tool: create or append to a visible local markdown project note under the Intercom R&D notes folder.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        title: { type: 'string', description: 'Note title.' },
        body: { type: 'string', description: 'Markdown body to write or append.' },
        bullets: { type: 'array', items: { type: 'string' }, description: 'Optional bullet items.' },
        append: { type: 'boolean', description: 'Append to an existing note instead of replacing the body. Default true.' }
      },
      required: ['title']
    }
  },
  {
    type: 'function',
    name: 'rd_dashboard_task',
    description: 'Productivity R&D tool: add/list/complete local Project Intercom R&D tasks in a small command-center JSON file.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        action: { type: 'string', enum: ['add', 'list', 'complete'], description: 'Task operation.' },
        title: { type: 'string', description: 'Task title for add/complete.' },
        description: { type: 'string', description: 'Optional task detail.' },
        priority: { type: 'string', enum: ['low', 'normal', 'high'], description: 'Priority for new task.' }
      },
      required: ['action']
    }
  },
  {
    type: 'function',
    name: 'codex_task_file',
    description: 'Productivity R&D tool: create a local Codex task brief file that can be picked up by Codex/app-server work.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        title: { type: 'string', description: 'Short task title.' },
        prompt: { type: 'string', description: 'Detailed task prompt/brief.' }
      },
      required: ['prompt']
    }
  },
  {
    type: 'function',
    name: 'browser_action',
    description: 'Visible R&D tool: open a URL in the browser or take a local screenshot of the current screen after browser navigation.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        action: { type: 'string', enum: ['open_url', 'screenshot_current'], description: 'Browser action.' },
        url: { type: 'string', description: 'URL to open for open_url.' }
      },
      required: ['action']
    }
  },
  {
    type: 'function',
    name: 'consulting_client_lookup',
    description: 'Lookup a Consulting dashboard client by query/name/clientName and return match counts, key identifiers/status/next action, invoices/changelog/BEN mentions. Dashboard-only; OpenClaw verification is flagged when needed.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        query: { type: 'string', description: 'Client search query.' },
        name: { type: 'string', description: 'Alias for query.' },
        clientName: { type: 'string', description: 'Alias for query.' },
        client: { type: 'string', description: 'Alias for query.' },
        title: { type: 'string', description: 'Alias for query.' },
        search: { type: 'string', description: 'Alias for query.' },
        q: { type: 'string', description: 'Alias for query.' },
        dashboard: { type: 'string', enum: ['consulting'], description: 'Optional dashboard selector; only consulting is supported.' },
        limit: { type: 'integer', minimum: 1, maximum: 20, description: 'Maximum client matches to summarize.' },
        includeActivity: { type: 'boolean', description: 'Accepted for compatibility; client record activity is included when present.' },
        includeRelationshipIntel: { type: 'boolean', description: 'Accepted for compatibility.' },
        includeInvoices: { type: 'boolean', description: 'Include matching invoices. Default true.' },
        includeChangelog: { type: 'boolean', description: 'Include matching changelog entries. Default true.' },
        includeBenMentions: { type: 'boolean', description: 'Include related BEN dashboard mentions. Default false for speed.' },
        includeRaw: { type: 'boolean', description: 'Include raw full client/BEN records. Default false for compact low-latency Realtime output.' },
        includeRawClient: { type: 'boolean', description: 'Alias for includeRaw.' },
        invoiceLimit: { type: 'integer', minimum: 1, maximum: 20, description: 'Max invoices to return. Default 5.' },
        changelogLimit: { type: 'integer', minimum: 1, maximum: 20, description: 'Max changelog entries to return. Default 5.' },
        benMentionLimit: { type: 'integer', minimum: 1, maximum: 12, description: 'Max BEN mentions to return when includeBenMentions is true. Default 5.' }
      },
      required: []
    }
  },
  {
    type: 'function',
    name: 'stage_delivery_to_openclaw',
    description: 'Stage text, local files, or inline attachments in the Project Intercom R&D workspace and asynchronously hand the manifest to OpenClaw/Julian for delivery under normal guardrails.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        title: { type: 'string', description: 'Short delivery title used for the staging folder.' },
        text: { type: 'string', description: 'Text/body/message to stage for delivery.' },
        body: { type: 'string', description: 'Alias for text.' },
        message: { type: 'string', description: 'Alias for text.' },
        files: {
          type: 'array',
          description: 'Absolute local file paths, or objects with path/filename/mimeType, to copy into staging.',
          items: {
            oneOf: [
              { type: 'string' },
              { type: 'object', additionalProperties: false, properties: { path: { type: 'string' }, filename: { type: 'string' }, mimeType: { type: 'string' } }, required: ['path'] }
            ]
          }
        },
        attachments: {
          type: 'array',
          description: 'Attachments as local paths, base64 content, or text content.',
          items: {
            type: 'object',
            additionalProperties: false,
            properties: {
              path: { type: 'string' },
              filePath: { type: 'string' },
              filename: { type: 'string' },
              name: { type: 'string' },
              mimeType: { type: 'string' },
              contentType: { type: 'string' },
              contentBase64: { type: 'string' },
              text: { type: 'string' }
            }
          }
        },
        delivery: {
          type: 'object',
          additionalProperties: false,
          properties: {
            channel: { type: 'string', description: 'Requested channel, e.g. signal or matrix.' },
            target: { type: 'string', description: 'Requested delivery target.' },
            to: { type: 'string', description: 'Alias for target.' },
            audience: { type: 'string', description: 'Human-readable audience, e.g. User.' },
            instructions: { type: 'string', description: 'Delivery instructions for OpenClaw.' },
            userOnly: { type: 'boolean', description: 'Default true. If true, OpenClaw should deliver only to User/internal approved destinations.' }
          }
        },
        instructions: { type: 'string', description: 'Additional delivery instructions.' },
        timeoutSeconds: { type: 'integer', minimum: 30, maximum: 1800, description: 'OpenClaw async handoff timeout. Default 600.' }
      },
      required: []
    }
  },
  {
    type: 'function',
    name: 'real_ben_calendar_lookup',
    description: 'Lookup calendar items from the REAL BEN dashboard local calendar data file backing port 7777. This does not call Google Calendar.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        query: { type: 'string', description: 'Optional text search across title, description, location, calendar, and status.' },
        date: { type: 'string', description: 'Specific date YYYY-MM-DD in Israel time.' },
        from: { type: 'string', description: 'Start date/datetime. YYYY-MM-DD is interpreted in Israel time.' },
        to: { type: 'string', description: 'End date/datetime. YYYY-MM-DD is interpreted in Israel time.' },
        datePreset: { type: 'string', enum: ['today', 'tomorrow', 'next_7_days', 'all'], description: 'Convenience date window.' },
        days: { type: 'integer', minimum: 1, maximum: 60, description: 'Upcoming N-day window starting today in Israel time.' },
        includePast: { type: 'boolean', description: 'If true and no date window is provided, include past items. Default false.' },
        limit: { type: 'integer', minimum: 1, maximum: 100, description: 'Maximum items to return.' }
      },
      required: []
    }
  },
  {
    type: 'function',
    name: 'ben_dashboard_items',
    description: 'List REAL BEN dashboard items with bucket/category placement, source email/thread metadata, user override flags, AI summary/classification metadata, freshness, and optional raw records.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        bucket: { type: 'string', enum: ['urgent', 'active', 'deferred', 'reminders', 'needs-review', 'completed', 'archived', 'auto-closed'], description: 'Filter to a BEN dashboard bucket/category.' },
        category: { type: 'string', enum: ['urgent', 'active', 'deferred', 'reminders', 'needs-review', 'completed', 'archived', 'auto-closed'], description: 'Alias for bucket.' },
        status: { type: 'string', description: 'Optional status text filter, e.g. overdue or action-needed.' },
        tag: { type: 'string', description: 'Optional exact tag filter, e.g. consulting or email.' },
        sourceType: { type: 'string', description: 'Optional source/sourceType filter, e.g. gmail, manual, twitter.' },
        query: { type: 'string', description: 'Optional search query across BEN item fields.' },
        sort: { type: 'string', enum: ['attention', 'updated', 'due', 'title'], description: 'Sort order. Default attention.' },
        includeMetadata: { type: 'boolean', description: 'Include source/userOverride/AI/placement metadata. Default true.' },
        includeRaw: { type: 'boolean', description: 'Include raw item records. Default false.' },
        limit: { type: 'integer', minimum: 1, maximum: 100, description: 'Maximum items to return.' }
      },
      required: []
    }
  },
  {
    type: 'function',
    name: 'ben_dashboard_item_lookup',
    description: 'Deep-read one REAL BEN dashboard item by query/id/title, including source email/thread fields, bucket/category placement, user overrides, AI classification/summary runtime metadata, related changelog entries, and optional raw record.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        query: { type: 'string', description: 'BEN item search query.' },
        id: { oneOf: [{ type: 'string' }, { type: 'number' }], description: 'BEN item id.' },
        title: { type: 'string', description: 'Alias for query.' },
        name: { type: 'string', description: 'Alias for query.' },
        includeRaw: { type: 'boolean', description: 'Include raw item and changelog records. Default false.' },
        includeChangelog: { type: 'boolean', description: 'Include related BEN changelog entries. Default true.' },
        limit: { type: 'integer', minimum: 1, maximum: 20, description: 'Maximum matches to summarize.' },
        changelogLimit: { type: 'integer', minimum: 1, maximum: 30, description: 'Maximum related changelog entries.' }
      },
      required: []
    }
  },
  {
    type: 'function',
    name: 'dashboard_open_card',
    description: 'Visible R&D tool: open an existing dashboard card by name/query (REAL BEN first, then Consulting by default), capture the opened card, browser-snapshot-review it, and optionally send the screenshot to User on Signal via Julian. No browser click-driving.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        dashboard: { type: 'string', enum: ['auto', 'real-ben', 'consulting'], description: 'Dashboard target. Default auto tries REAL BEN first, then Consulting.' },
        clientName: { type: 'string', description: 'Client/card name to open.' },
        name: { type: 'string', description: 'Alternate card name field.' },
        query: { type: 'string', description: 'General card search query.' },
        sendSignal: { type: 'boolean', description: 'Send the reviewed screenshot to User on Signal via Julian. Default true.' },
        timeoutMs: { type: 'integer', minimum: 1000, maximum: 180000, description: 'Optional local call timeout.' }
      },
      required: []
    }
  },
  {
    type: 'function',
    name: 'openclaw_status',
    description: 'Read real local OpenClaw status from this machine through the local MCP adapter.',
    parameters: { type: 'object', additionalProperties: false, properties: { includeRaw: { type: 'boolean', description: 'Include raw CLI stdout/stderr. Default false.' } }, required: [] }
  },
  {
    type: 'function',
    name: 'openclaw_default_model',
    description: 'Read the configured default OpenClaw model from this machine through the local MCP adapter.',
    parameters: { type: 'object', additionalProperties: false, properties: {}, required: [] }
  },
  {
    type: 'function',
    name: 'dashboard_data_map',
    description: 'Inspect available REAL BEN, Consulting, and System Monitor dashboard data files, fields, counts, freshness, and source URLs.',
    parameters: { type: 'object', additionalProperties: false, properties: { dashboard: { type: 'string', enum: ['ben', 'consulting', 'system', 'all'] }, includeFields: { type: 'boolean' }, includeCounts: { type: 'boolean' } }, required: [] }
  },
  {
    type: 'function',
    name: 'dashboard_overview',
    description: 'Broad read-only overview of BEN, Consulting, System Monitor, or all dashboards with summary, warnings, and next actions.',
    parameters: { type: 'object', additionalProperties: false, properties: { dashboard: { type: 'string', enum: ['ben', 'consulting', 'system', 'all'] }, focus: { type: 'string', enum: ['urgent', 'changes', 'stale', 'attention', 'revenue', 'health', 'all'] }, timeWindowHours: { type: 'integer', minimum: 1, maximum: 168 }, limit: { type: 'integer', minimum: 1, maximum: 30 } }, required: [] }
  },
  {
    type: 'function',
    name: 'dashboard_search',
    description: 'Search BEN, Consulting, and System Monitor records for tasks, clients, invoices, changes, agents, improvements, model audit entries, calendar/email cache, and X-scan cache.',
    parameters: { type: 'object', additionalProperties: false, properties: { query: { type: 'string' }, dashboards: { type: 'array', items: { type: 'string', enum: ['ben', 'consulting', 'system'] } }, recordTypes: { type: 'array', items: { type: 'string', enum: ['task', 'client', 'invoice', 'calendar_event', 'change', 'agent', 'cron', 'improvement', 'model_audit', 'body_status', 'x_scan', 'email', 'any'] } }, limit: { type: 'integer', minimum: 1, maximum: 50 }, includeSnippets: { type: 'boolean' } }, required: ['query'] }
  },
  {
    type: 'function',
    name: 'dashboard_card_lookup',
    description: 'Fetch one dashboard card/record by title/name/query and return key fields, source file, index, raw record, and recommended next action.',
    parameters: { type: 'object', additionalProperties: false, properties: { query: { type: 'string' }, dashboard: { type: 'string', enum: ['ben', 'consulting', 'system', 'all'] }, dashboards: { type: 'array', items: { type: 'string', enum: ['ben', 'consulting', 'system'] } }, limit: { type: 'integer', minimum: 1, maximum: 20 } }, required: ['query'] }
  },
  {
    type: 'function',
    name: 'dashboard_attention_queue',
    description: 'Rank what needs attention across BEN, Consulting, and System Monitor by urgency, revenue, deadline, stale state, response-needed state, and system errors.',
    parameters: { type: 'object', additionalProperties: false, properties: { dashboards: { type: 'array', items: { type: 'string', enum: ['ben', 'consulting', 'system'] } }, mode: { type: 'string', enum: ['user', 'agent', 'business', 'ops', 'all'] }, maxItems: { type: 'integer', minimum: 1, maximum: 50 }, includeRationale: { type: 'boolean' } }, required: [] }
  },
  {
    type: 'function',
    name: 'consulting_response_needed',
    description: 'List Consulting dashboard clients marked or inferred as needing response; flags that definitive status requires OpenClaw sent/received email verification.',
    parameters: { type: 'object', additionalProperties: false, properties: { includeStale: { type: 'boolean' }, minAgeHours: { type: 'integer', minimum: 0, maximum: 720 }, limit: { type: 'integer', minimum: 1, maximum: 50 } }, required: [] }
  },
  {
    type: 'function',
    name: 'dashboard_contradiction_scan',
    description: 'Find stale/conflicting dashboard facts across BEN, Consulting, and System Monitor, such as response-needed closed clients or open invoices for closed/paid clients.',
    parameters: { type: 'object', additionalProperties: false, properties: { scope: { type: 'string', enum: ['consulting', 'tasks', 'system', 'all'] }, entity: { type: 'string' }, severity: { type: 'string', enum: ['high', 'medium', 'all'] } }, required: [] }
  },
  {
    type: 'function',
    name: 'dashboard_next_action_recommender',
    description: 'Generate ranked next actions from dashboard evidence, with money/ops/schedule prioritization and OpenClaw escalation flags where verification is required.',
    parameters: { type: 'object', additionalProperties: false, properties: { domain: { type: 'string', enum: ['money', 'ops', 'schedule', 'all'] }, timeBudgetMinutes: { type: 'integer', minimum: 5, maximum: 240 }, riskTolerance: { type: 'string', enum: ['low', 'normal', 'aggressive'] }, maxRecommendations: { type: 'integer', minimum: 1, maximum: 10 } }, required: [] }
  },
  {
    type: 'function',
    name: 'system_agent_deployments',
    description: 'Read current and recently active agent deployments from the System Monitor Agent Deployments panel plus local session indexes.',
    parameters: { type: 'object', additionalProperties: false, properties: { windowHours: { type: 'integer', minimum: 1, maximum: 168 }, includePanel: { type: 'boolean' }, includeSessionIndex: { type: 'boolean' }, limit: { type: 'integer', minimum: 1, maximum: 100 } }, required: [] }
  },
  {
    type: 'function',
    name: 'sec_edgar_search',
    description: 'Search SEC EDGAR recent company submissions by ticker/CIK with form, date, and after-hours filters using the local SEC helper.',
    parameters: { type: 'object', additionalProperties: false, properties: { identifiers: { type: 'array', items: { type: 'string' }, minItems: 1, maxItems: 20 }, forms: { type: 'string' }, formPrefix: { type: 'boolean' }, after: { type: 'string' }, before: { type: 'string' }, afterHours: { type: 'boolean' }, afterHoursStart: { type: 'string' }, afterHoursEnd: { type: 'string' }, limit: { type: 'integer', minimum: 1, maximum: 200 }, userAgent: { type: 'string' }, timeoutMs: { type: 'integer', minimum: 5000, maximum: 120000 } }, required: ['identifiers'] }
  }
];

const RND_MCP_TOOL_NAMES = new Set(RND_MCP_TOOLS.map((tool) => tool.name));

const LOCAL_MCP_CALL_TOOLS = [
  {
    type: 'function',
    name: 'local_mcp_call',
    description: 'Call one approved local MCP stdio tool by name. IMPORTANT: for search/lookup tools, include either arguments:{query:"..."} or top-level query/clientName/name. Examples: {tool:"consulting_client_lookup", arguments:{query:"Brenner"}}; {tool:"dashboard_search", arguments:{query:"Brenner", dashboards:["consulting"]}}; {tool:"dashboard_card_lookup", arguments:{query:"Brenner", dashboard:"consulting"}}.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        tool: { type: 'string', description: 'Local MCP tool name: ben_dashboard_items, ben_dashboard_item_lookup, consulting_client_lookup, dashboard_search, dashboard_card_lookup, dashboard_overview, dashboard_data_map, dashboard_attention_queue, consulting_response_needed, dashboard_contradiction_scan, dashboard_next_action_recommender, system_agent_deployments, stage_delivery_to_openclaw, real_ben_calendar_lookup, sec_edgar_search, screen_capture_summary, rd_dashboard_task, openclaw_status, openclaw_default_model.' },
        arguments: { type: 'object', additionalProperties: true, description: 'JSON object arguments for the selected local MCP tool. For consulting_client_lookup and dashboard_search this must include query/name/clientName, e.g. {"query":"Brenner"}.' },
        query: { type: 'string', description: 'Convenience top-level query alias. The bridge copies this into arguments.query if arguments is missing/incomplete.' },
        clientName: { type: 'string', description: 'Convenience top-level client name alias for consulting_client_lookup.' },
        name: { type: 'string', description: 'Convenience top-level name alias.' },
        dashboard: { type: 'string', description: 'Convenience top-level dashboard selector.' },
        limit: { type: 'integer', minimum: 1, maximum: 100, description: 'Convenience top-level result limit.' }
      },
      required: ['tool']
    }
  }
];


function localMcpCatalogPrompt() {
  return `
# Local MCP tool catalog and required argument examples
When calling local_mcp_call, always pass the selected tool AND its arguments. Do not call lookup/search tools with only the tool name.
- consulting_client_lookup: local_mcp_call({"tool":"consulting_client_lookup","arguments":{"query":"Brenner","limit":3}}). Accepts query/name/clientName/client/title/search/q.
- ben_dashboard_items: local_mcp_call({"tool":"ben_dashboard_items","arguments":{"bucket":"urgent","includeMetadata":true,"limit":10}}).
- ben_dashboard_item_lookup: local_mcp_call({"tool":"ben_dashboard_item_lookup","arguments":{"query":"Charles Brenner","includeChangelog":true,"includeRaw":false}}).
- dashboard_search: local_mcp_call({"tool":"dashboard_search","arguments":{"query":"Brenner","dashboards":["consulting"],"limit":5}}).
- dashboard_card_lookup: local_mcp_call({"tool":"dashboard_card_lookup","arguments":{"query":"Brenner","dashboard":"consulting"}}).
- consulting_response_needed: local_mcp_call({"tool":"consulting_response_needed","arguments":{"limit":10}}).
- dashboard_data_map: local_mcp_call({"tool":"dashboard_data_map","arguments":{"dashboard":"all"}}).
- dashboard_overview: local_mcp_call({"tool":"dashboard_overview","arguments":{"dashboard":"all","focus":"attention"}}).
- dashboard_attention_queue: local_mcp_call({"tool":"dashboard_attention_queue","arguments":{"dashboards":["ben","consulting","system"],"maxItems":10}}).
- real_ben_calendar_lookup: local_mcp_call({"tool":"real_ben_calendar_lookup","arguments":{"datePreset":"today","limit":10}}).
- stage_delivery_to_openclaw: local_mcp_call({"tool":"stage_delivery_to_openclaw","arguments":{"title":"...","text":"...","delivery":{"audience":"User","instructions":"..."}}}).
- sec_edgar_search: local_mcp_call({"tool":"sec_edgar_search","arguments":{"identifiers":["AAPL"],"forms":"8-K","limit":5}}).
If a user asks “look up X”, “find X”, or names a client, include X as arguments.query. If the tool returns a missing_query error, immediately call it again with the query from the user's request.`;
}

const REALTIME_MCP_TOOLS_INSTRUCTIONS = process.env.REALTIME_MCP_TOOLS_INSTRUCTIONS || `
# Role
- You are GPT-Realtime-2 in Project Intercom R&D tools mode.
- Realtime sees a single server-owned function tool: local_mcp_call({ tool, arguments }).
- Use local_mcp_call for the visible local MCP tool catalog: dashboard reading/search/attention/recommendation tools for BEN, Consulting, and System Monitor; System Monitor agent deployments; SEC/EDGAR search; staged delivery handoff to OpenClaw; REAL BEN dashboard calendar lookup; app arrangement; local screen capture summary; project notes; R&D task command center; Codex task briefs; browser actions; dashboard card opening/screenshot delivery; and narrow OpenClaw local status/model checks.
- Do not narrate tool mechanics. After successful tool calls, give the substantive result the user asked for. Never answer only 'done', 'completed', 'finished', or 'successful'.
- These tools are intentionally full-power R&D primitives. Do not nerf them into toy/demo-only behavior.
- If the user asks for broader OpenClaw/Julian work and OpenClaw tools are not present in this session, say briefly that OpenClaw Tools or MCP + OpenClaw is needed.
${localMcpCatalogPrompt()}
`;

const REALTIME_HYBRID_TOOLS_INSTRUCTIONS = process.env.REALTIME_HYBRID_TOOLS_INSTRUCTIONS || `
# Role
- You are GPT-Realtime-2 in Project Intercom R&D hybrid mode.
- You have two lanes:
  1. local_mcp_call({ tool, arguments }) for fast local MCP actions. The MCP server owns and expands this catalog; call it for concrete local tool work.
  2. openclaw_turn({ text, urgency }) for the full local OpenClaw agent runtime. This is the high-power lane. It is NOT limited to the three Realtime bridge functions and it is NOT limited to the MCP catalog. When you call openclaw_turn, pass the user's complete intent and let OpenClaw decide/use whatever local tools, files, shell commands, browser actions, memory, crons, messages, subagents, coding/research flows, dashboards, and longer-running work are appropriate under its normal agent rules.
- Do not tell the user that OpenClaw only has a few tools in this mode. The Realtime API sees only a small bridge surface, but the OpenClaw runtime behind that bridge has its normal broad local tool authority.
- Prefer the server-owned web_search function for fresh public web lookup; prefer local_mcp_call for quick concrete local actions; prefer openclaw_turn for anything that benefits from agentic judgment, multi-step work, broad tools, current-state investigation, or autonomy.
- If local_mcp_call cannot directly do what the user wants, call openclaw_turn to get it done. If OpenClaw is already active and the user adds/corrects/changes instructions or asks a follow-up, call steer_openclaw immediately rather than waiting or claiming you cannot send another request. You can send steering while OpenClaw is active. In the text to OpenClaw, explicitly say that no suitable direct MCP tool was available and ask OpenClaw to consider whether to make/stage/recommend a modification of an existing local MCP tool or a future direct local MCP tool for this pattern. Default yes when future repeats would be faster/directer as a local tool than via OpenClaw routing. Ask OpenClaw/Julian to message the Matrix room “Realtime Tool Creation” either way with the recommendation and why, and to keep that Matrix note brief. If OpenClaw/Julian creates the tool, tell it that the completed tool should be registered in the local MCP catalog behind local_mcp_call, not left as a separate side server and not described as OpenAI-native unless OpenAI actually hosts/executes it.
- These tools are intentionally full-power R&D primitives. Do not nerf them into toy/demo-only behavior.
- Keep spoken replies concise, natural, and substantive. Do not narrate mechanics. Never answer only 'done', 'completed', 'finished', or 'successful' after a tool call; state the useful result itself. Explain only on request, failure, or real blocker.
`;

const realtimeTurns = new Map();

const MAX_CLASSIC_PENDING_TURNS = Number(process.env.VB_MAX_PENDING_TURNS || 3);
const MAX_REALTIME_PENDING_TURNS = Number(process.env.VB_REALTIME_MAX_PENDING_TURNS || 3);
const MIN_PROBE_RMS = Number(process.env.VB_PROBE_MIN_RMS || 140);
const MIN_TURN_RMS = Number(process.env.VB_TURN_MIN_RMS || 90);
const MIN_AUDIO_BYTES = Number(process.env.VB_MIN_AUDIO_BYTES || 1200);
const REALTIME_SIDEBAND_ENABLED = !['0', 'false', 'off'].includes(String(process.env.REALTIME_SIDEBAND_ENABLED || '1').toLowerCase());
const REALTIME_SIDEBAND_OPEN_TIMEOUT_MS = Number(process.env.REALTIME_SIDEBAND_OPEN_TIMEOUT_MS || 2500);
const realtimeSidebands = new Map();
const realtimePendingCounts = new Map();
const realtimeCancelTombstones = new Map();
const realtimeSessionConfigs = new Map();


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

function buildRealtimeTurnDetection(mode) {
  const normalized = normalizeTurnDetectionMode(mode);
  if (normalized === 'none') return null;
  if (normalized === 'semantic_vad') {
    return { type: 'semantic_vad', eagerness: REALTIME_SEMANTIC_VAD_EAGERNESS, create_response: true, interrupt_response: true };
  }
  return { type: 'server_vad', threshold: REALTIME_VAD_THRESHOLD, prefix_padding_ms: REALTIME_VAD_PREFIX_PADDING_MS, silence_duration_ms: REALTIME_VAD_SILENCE_DURATION_MS, create_response: true, interrupt_response: true };
}

function realtimeRequestOptions(req, routeMode, sessionToken) {
  const url = new URL(req.url, `http://localhost:${PORT}`);
  const processing = parseJsonHeader(req.headers['x-openclaw-processing']);
  const captions = parseRealtimeBoolean(req.headers['x-realtime-captions'] ?? url.searchParams.get('captions'), REALTIME_TRANSCRIPTION_DEFAULT);
  const turnDetection = normalizeTurnDetectionMode(req.headers['x-realtime-turn-detection'] || url.searchParams.get('vad'));
  const realtimeReasoning = normalizeRealtimeReasoning(req.headers['x-realtime-reasoning'] || url.searchParams.get('reasoning'));
  const transcriptionDelay = normalizeTranscriptionDelay(req.headers['x-realtime-transcription-delay'] || url.searchParams.get('transcriptionDelay'));
  const transcriptionLanguage = String(req.headers['x-realtime-transcription-language'] || url.searchParams.get('language') || REALTIME_TRANSCRIPTION_LANGUAGE || '').trim();
  return {
    sessionToken: sanitizeRealtimeSessionToken(sessionToken),
    routeMode,
    processing,
    captions,
    turnDetection,
    realtimeReasoning,
    transcriptionDelay,
    transcriptionLanguage,
    createdAt: Date.now(),
  };
}

function buildRealtimeAudioConfig(options = {}) {
  const input = { noise_reduction: { type: 'near_field' } };
  if (options.captions) {
    input.transcription = { model: REALTIME_TRANSCRIPTION_MODEL, delay: options.transcriptionDelay || REALTIME_TRANSCRIPTION_DELAY };
    if (options.transcriptionLanguage) input.transcription.language = options.transcriptionLanguage;
  }
  const turnDetection = buildRealtimeTurnDetection(options.turnDetection);
  input.turn_detection = turnDetection;
  return { input, output: { voice: REALTIME_VOICE } };
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

function closeRealtimeSideband(sessionToken, reason = 'client disconnect') {
  const key = sanitizeRealtimeSessionToken(sessionToken);
  const ws = realtimeSidebands.get(key);
  if (ws) {
    try { ws.close(1000, reason); } catch {}
    realtimeSidebands.delete(key);
  }
  realtimeSessionConfigs.delete(key);
  realtimePendingCounts.delete(key);
  return !!ws;
}

function bridgeStatusSnapshot(sessionToken = '') {
  const key = sanitizeRealtimeSessionToken(sessionToken);
  const current = realtimeTurns.get(key);
  const sideband = realtimeSidebands.get(key);
  const sidebandState = sideband ? ['connecting', 'open', 'closing', 'closed'][sideband.readyState] || String(sideband.readyState) : 'none';
  const sessionConfig = realtimeSessionConfigs.get(key) || null;
  return { active: !!current, turnId: current?.turnId || null, activeForMs: current ? Date.now() - current.startedAt : 0, realtimePending: realtimeQueueCount(key), maxRealtimePending: MAX_REALTIME_PENDING_TURNS, sideband: sidebandState, sidebandEnabled: REALTIME_SIDEBAND_ENABLED, sessionConfig, tts: getTtsStatus() };
}

function sendSidebandEvent(ws, event) { if (ws?.readyState === WebSocket.OPEN) ws.send(JSON.stringify(event)); }

function safeSlug(value = 'untitled') {
  const clean = String(value || 'untitled').trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
  return clean.slice(0, 80) || 'untitled';
}

function isoCompact() { return new Date().toISOString().replace(/[:.]/g, '-'); }

async function runCommand(command, args = [], options = {}) {
  const result = await execFileAsync(command, args, { timeout: options.timeoutMs || 8000, maxBuffer: options.maxBuffer || 800_000, ...options });
  return { stdout: String(result.stdout || '').trim(), stderr: String(result.stderr || '').trim() };
}

async function osascript(script, options = {}) {
  return runCommand('/usr/bin/osascript', ['-e', script], options);
}

async function toolWorkspaceArrangeApps(args = {}) {
  const preset = args.preset || 'intercom_demo';
  const apps = Array.isArray(args.apps) && args.apps.length ? args.apps.map((app) => String(app || '').trim()).filter(Boolean) : (preset === 'browser_notes' ? ['Google Chrome', 'TextEdit'] : ['Google Chrome', 'Terminal']);
  if (!apps.length) return { ok: false, error: 'No app names requested.' };
  for (const app of apps.slice(0, 4)) {
    await osascript(`tell application ${JSON.stringify(String(app))} to activate`, { timeoutMs: 4000 }).catch(() => null);
  }
  if (preset !== 'focus_only') {
    const script = `
tell application "System Events"
  set screenWidth to 1728
  set screenHeight to 1117
  set visibleApps to {${apps.slice(0, 2).map((a) => JSON.stringify(String(a))).join(',')}}
  repeat with i from 1 to count of visibleApps
    set appName to item i of visibleApps
    if exists process appName then
      tell process appName
        if exists window 1 then
          if i is 1 then
            set position of window 1 to {0, 25}
            set size of window 1 to {864, 1030}
          else
            set position of window 1 to {864, 25}
            set size of window 1 to {864, 1030}
          end if
        end if
      end tell
    end if
  end repeat
end tell`;
    await osascript(script, { timeoutMs: 6000 }).catch(() => null);
  }
  return { ok: true, preset, apps: apps.slice(0, 4), summary: `Activated ${apps.slice(0, 4).join(', ')}${preset === 'focus_only' ? '' : ' and arranged the first two windows side by side'}.` };
}

async function frontWindowSummary() {
  const script = `
tell application "System Events"
  set frontApp to name of first application process whose frontmost is true
  set winTitle to ""
  try
    tell process frontApp
      if exists window 1 then set winTitle to name of window 1
    end tell
  end try
  return frontApp & "||" & winTitle
end tell`;
  const { stdout } = await osascript(script, { timeoutMs: 4000 }).catch(() => ({ stdout: 'unknown||' }));
  const [frontApp, windowTitle] = stdout.split('||');
  return { frontApp: frontApp || 'unknown', windowTitle: windowTitle || '' };
}

async function toolScreenCaptureSummary(args = {}) {
  await mkdir(RD_SCREENSHOT_DIR, { recursive: true });
  const screenshotPath = join(RD_SCREENSHOT_DIR, `screen-${isoCompact()}.png`);
  const front = await frontWindowSummary();
  let captured = true;
  let captureError = '';
  try {
    await runCommand('/usr/sbin/screencapture', ['-x', screenshotPath], { timeoutMs: 8000 });
  } catch (err) {
    captured = false;
    captureError = err.message;
  }
  let ocr = '';
  if (captured && args.includeOcr !== false) {
    const tesseract = await runCommand('/usr/bin/which', ['tesseract'], { timeoutMs: 2000 }).catch(() => null);
    if (tesseract?.stdout) {
      const ocrResult = await runCommand(tesseract.stdout, [screenshotPath, 'stdout'], { timeoutMs: 15000, maxBuffer: 500_000 }).catch((err) => ({ stdout: '', stderr: err.message }));
      ocr = String(ocrResult.stdout || '').trim().replace(/\s+/g, ' ').slice(0, 1200);
    }
  }
  const summary = captured
    ? `Captured the screen locally. Front app: ${front.frontApp}${front.windowTitle ? ` — ${front.windowTitle}` : ''}${ocr ? `. Local OCR excerpt: ${ocr.slice(0, 240)}` : '.'}`
    : `Screen image capture is unavailable in this runtime (${captureError.split('\n')[0]}). Front app: ${front.frontApp}${front.windowTitle ? ` — ${front.windowTitle}` : ''}.`;
  return { ok: true, captured, screenshotPath: captured ? screenshotPath : null, captureError: captured ? '' : captureError, ...front, ocr, summary };
}

async function toolProjectNoteUpdate(args = {}) {
  await mkdir(RD_NOTES_DIR, { recursive: true });
  const title = String(args.title || 'Project Intercom Note').trim();
  const filePath = join(RD_NOTES_DIR, `${safeSlug(title)}.md`);
  const bullets = Array.isArray(args.bullets) && args.bullets.length ? `\n${args.bullets.map((b) => `- ${String(b).trim()}`).join('\n')}\n` : '';
  const body = String(args.body || '').trim();
  const entry = `\n\n## ${new Date().toLocaleString('en-IL', { timeZone: 'Asia/Jerusalem' })}\n${body ? `${body}\n` : ''}${bullets}`.trim() + '\n';
  let existing = '';
  if (args.append !== false) existing = await readFile(filePath, 'utf8').catch(() => `# ${title}\n`);
  await writeFile(filePath, existing ? `${existing.trim()}\n\n${entry}` : `# ${title}\n\n${entry}`);
  return { ok: true, title, filePath, summary: `Updated note “${title}” at ${filePath}.` };
}

async function readDashboardTasks() {
  const raw = await readFile(RD_DASHBOARD_TASKS_FILE, 'utf8').catch(() => '{"tasks":[]}');
  try { const parsed = JSON.parse(raw); return Array.isArray(parsed.tasks) ? parsed : { tasks: [] }; } catch { return { tasks: [] }; }
}

async function writeDashboardTasks(data) {
  await mkdir(RD_DATA_DIR, { recursive: true });
  await writeFile(RD_DASHBOARD_TASKS_FILE, JSON.stringify({ ...data, updatedAt: new Date().toISOString() }, null, 2));
}

async function toolRdDashboardTask(args = {}) {
  const action = args.action || 'list';
  const data = await readDashboardTasks();
  if (action === 'add') {
    const task = { id: `rd-${Date.now().toString(36)}`, title: String(args.title || 'Untitled R&D task').trim(), description: String(args.description || '').trim(), priority: args.priority || 'normal', status: 'open', createdAt: new Date().toISOString() };
    data.tasks.push(task);
    await writeDashboardTasks(data);
    return { ok: true, task, filePath: RD_DASHBOARD_TASKS_FILE, summary: `Added R&D dashboard task: ${task.title}.` };
  }
  if (action === 'complete') {
    const wanted = String(args.title || '').toLowerCase();
    if (!wanted.trim()) return { ok: false, error: 'A non-empty title is required to complete an R&D dashboard task.', filePath: RD_DASHBOARD_TASKS_FILE };
    const task = data.tasks.find((item) => item.status !== 'done' && item.title.toLowerCase().includes(wanted));
    if (task) { task.status = 'done'; task.completedAt = new Date().toISOString(); await writeDashboardTasks(data); }
    return { ok: !!task, task: task || null, filePath: RD_DASHBOARD_TASKS_FILE, summary: task ? `Completed R&D dashboard task: ${task.title}.` : 'No matching open R&D task found.' };
  }
  const open = data.tasks.filter((task) => task.status !== 'done').slice(-10);
  return { ok: true, tasks: open, filePath: RD_DASHBOARD_TASKS_FILE, summary: open.length ? `Open R&D tasks: ${open.map((t) => t.title).join('; ')}.` : 'No open R&D tasks.' };
}

async function toolCodexTaskFile(args = {}) {
  await mkdir(RD_CODEX_TASK_DIR, { recursive: true });
  const title = String(args.title || 'Codex R&D Task').trim();
  const filePath = join(RD_CODEX_TASK_DIR, `${isoCompact()}-${safeSlug(title)}.md`);
  const prompt = String(args.prompt || '').trim();
  await writeFile(filePath, `# ${title}\n\nCreated: ${new Date().toISOString()}\n\n## Prompt\n\n${prompt}\n`);
  return { ok: true, title, filePath, summary: `Created Codex task brief “${title}” at ${filePath}.` };
}

async function toolBrowserAction(args = {}) {
  const action = args.action || 'open_url';
  if (action === 'open_url') {
    const url = String(args.url || '').trim();
    if (!/^https?:\/\//i.test(url)) return { ok: false, error: 'URL must start with http:// or https://' };
    await runCommand('/usr/bin/open', ['-a', 'Google Chrome', url], { timeoutMs: 5000 }).catch(async () => runCommand('/usr/bin/open', [url], { timeoutMs: 5000 }));
    return { ok: true, url, summary: `Opened ${url} in the browser.` };
  }
  const capture = await toolScreenCaptureSummary({ includeOcr: false });
  return { ok: true, ...capture, summary: `Captured the current browser/screen view at ${capture.screenshotPath}.` };
}

function decodeHtmlEntities(text = '') {
  return String(text || '')
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&#x([0-9a-f]+);/gi, (_, hex) => String.fromCodePoint(parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(parseInt(n, 10)));
}

function stripHtml(text = '') {
  return decodeHtmlEntities(String(text || '').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim());
}

function normalizeDuckDuckGoUrl(raw = '') {
  const value = decodeHtmlEntities(raw);
  try {
    const parsed = new URL(value, 'https://duckduckgo.com');
    const uddg = parsed.searchParams.get('uddg');
    return uddg ? decodeURIComponent(uddg) : parsed.href;
  } catch {
    return value;
  }
}

async function toolWebSearch(args = {}) {
  const query = String(args.query || '').trim();
  if (!query) return { ok: false, error: 'web_search requires a non-empty query.' };
  const count = Math.max(1, Math.min(10, Number(args.count || 5) || 5));
  const params = new URLSearchParams({ q: query });
  if (args.country) params.set('kl', String(args.country).toLowerCase());
  const url = `https://html.duckduckgo.com/html/?${params.toString()}`;
  let html = '';
  try {
    const response = await fetch(url, {
      headers: {
        'User-Agent': 'OpenClaw-Realtime-RD/1.0 (+local R&D web_search tool)',
        'Accept': 'text/html,application/xhtml+xml',
      },
      signal: AbortSignal.timeout(15000),
    });
    if (!response.ok) return { ok: false, provider: 'duckduckgo-html', error: `DuckDuckGo returned HTTP ${response.status}.` };
    html = await response.text();
  } catch (err) {
    return { ok: false, provider: 'duckduckgo-html', error: `web_search request failed: ${err.message}` };
  }

  const results = [];
  const blockRegex = /<div[^>]+class="[^"]*result[^"]*"[\s\S]*?(?=<div[^>]+class="[^"]*result[^"]*"|<\/body>|$)/gi;
  const blocks = html.match(blockRegex) || [];
  for (const block of blocks) {
    const link = block.match(/<a[^>]+class="[^"]*result__a[^"]*"[^>]+href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/i);
    if (!link) continue;
    const title = stripHtml(link[2]);
    const resultUrl = normalizeDuckDuckGoUrl(link[1]);
    const snippetMatch = block.match(/<a[^>]+class="[^"]*result__snippet[^"]*"[^>]*>([\s\S]*?)<\/a>/i) || block.match(/<div[^>]+class="[^"]*result__snippet[^"]*"[^>]*>([\s\S]*?)<\/div>/i);
    const snippet = snippetMatch ? stripHtml(snippetMatch[1]) : '';
    if (title && resultUrl && !results.some((item) => item.url === resultUrl)) results.push({ title, url: resultUrl, snippet });
    if (results.length >= count) break;
  }
  const summary = results.length ? `Found ${results.length} web result${results.length === 1 ? '' : 's'} for “${query}”.` : `No web results found for “${query}”.`;
  return { ok: true, provider: 'duckduckgo-html', query, count, results, summary };
}

function normalizeLocalMcpArguments(payload = {}) {
  const out = payload.arguments && typeof payload.arguments === 'object' && !Array.isArray(payload.arguments) ? { ...payload.arguments } : {};
  for (const key of ['query', 'clientName', 'name', 'client', 'title', 'search', 'q', 'dashboard', 'dashboards', 'limit', 'date', 'from', 'to', 'datePreset', 'days', 'identifiers', 'forms', 'includeBenMentions', 'includeRaw', 'includeRawClient', 'invoiceLimit', 'changelogLimit', 'benMentionLimit']) {
    if (payload[key] !== undefined && out[key] === undefined) out[key] = payload[key];
  }
  return out;
}

async function handleRdRealtimeTool(name, args = {}, sessionToken = '') {
  const startedAt = Date.now();
  let result;
  if (name === 'workspace_arrange_apps') result = await toolWorkspaceArrangeApps(args);
  else if (name === 'screen_capture_summary') result = await toolScreenCaptureSummary(args);
  else if (name === 'project_note_update') result = await toolProjectNoteUpdate(args);
  else if (name === 'rd_dashboard_task') result = await toolRdDashboardTask(args);
  else if (name === 'codex_task_file') result = await toolCodexTaskFile(args);
  else if (name === 'browser_action') result = await toolBrowserAction(args);
  else if (name === 'dashboard_open_card') {
    const mcpResult = await callOpenClawMcpTool('dashboard_open_card', args);
    result = { ...mcpResult, summary: mcpResult.result?.summary || mcpResult.error || 'dashboard_open_card completed.' };
  }
  else result = { ok: false, error: `Unsupported R&D tool: ${name}` };
  await appendRealtimeLog({ kind: 'rd_mcp_tool_result', sessionToken: sanitizeRealtimeSessionToken(sessionToken), toolName: name, ok: !!result.ok, elapsedMs: Date.now() - startedAt, summary: result.summary || result.error || '' });
  return result;
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

async function handleRealtimeSidebandToolCall(ws, event, sessionToken) {
  const name = event.name || event.tool_name || event.function?.name;
  const callId = event.call_id || event.callId || event.item_id || event.id;
  if (!callId) return;
  let args = {};
  try { args = JSON.parse(event.arguments || event.output || '{}'); } catch {}
  await appendRealtimeLog({ kind: 'sideband_function_requested', sessionToken: sanitizeRealtimeSessionToken(sessionToken), name, callId, args });
  const exact = (text) => `Say exactly this text and nothing else:\n${String(text || '').trim()}`;
  const outputAndSpeak = (output, { speak = true } = {}) => {
    sendSidebandEvent(ws, { type: 'conversation.item.create', item: { type: 'function_call_output', call_id: callId, output } });
    appendRealtimeLog({ kind: 'sideband_function_output_sent', sessionToken: sanitizeRealtimeSessionToken(sessionToken), name, callId, outputPreview: String(output || '').slice(0, 500) });
    if (speak) {
      sendSidebandEvent(ws, { type: 'response.create', response: { instructions: exact(output) } });
      appendRealtimeLog({ kind: 'sideband_response_create_sent', sessionToken: sanitizeRealtimeSessionToken(sessionToken), name, callId, spoken: String(output || '').slice(0, 500) });
    }
  };
  const outputJsonAndSpeakSummary = (result, { speak = true } = {}) => {
    const output = JSON.stringify(result);
    const spoken = toolResultSpeechSeed(result);
    sendSidebandEvent(ws, { type: 'conversation.item.create', item: { type: 'function_call_output', call_id: callId, output } });
    appendRealtimeLog({ kind: 'sideband_function_output_sent', sessionToken: sanitizeRealtimeSessionToken(sessionToken), name, callId, ok: result?.ok, outputPreview: output.slice(0, 500) });
    if (speak) {
      sendSidebandEvent(ws, { type: 'response.create', response: { instructions: toolResultAnswerInstructions(result, spoken) } });
      appendRealtimeLog({ kind: 'sideband_response_create_sent', sessionToken: sanitizeRealtimeSessionToken(sessionToken), name, callId, spoken: String(spoken || '').slice(0, 500), substantive: true });
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
  if (name === 'web_search') {
    try {
      const result = await toolWebSearch(args);
      outputJsonAndSpeakSummary(result);
      await appendRealtimeLog({ kind: 'web_search_result', sessionToken: sanitizeRealtimeSessionToken(sessionToken), ok: !!result.ok, provider: result.provider, query: args.query || '', resultCount: result.results?.length || 0 });
    } catch (err) {
      outputJsonAndSpeakSummary({ ok: false, error: `web_search error: ${err.message}` });
      await appendRealtimeLog({ kind: 'web_search_error', sessionToken: sanitizeRealtimeSessionToken(sessionToken), error: err.message });
    }
    return;
  }
  if (name === 'local_mcp_call') {
    const requestedTool = String(args.tool || '').trim();
    const requestedArgs = normalizeLocalMcpArguments(args);
    try {
      const mcpResult = await callOpenClawMcpTool(requestedTool, requestedArgs);
      outputJsonAndSpeakSummary({ ...mcpResult, summary: mcpResult.result?.summary || mcpResult.error || `Local MCP tool ${requestedTool} returned a result.` });
      await appendRealtimeLog({ kind: 'local_mcp_call_result', sessionToken: sanitizeRealtimeSessionToken(sessionToken), callId, toolName: requestedTool, ok: mcpResult.ok, elapsedMs: mcpResult.elapsedMs, listedTools: mcpResult.listedTools });
    } catch (err) {
      outputJsonAndSpeakSummary({ ok: false, error: `Local MCP adapter error: ${err.message}` });
      await appendRealtimeLog({ kind: 'local_mcp_call_error', sessionToken: sanitizeRealtimeSessionToken(sessionToken), callId, toolName: requestedTool, error: err.message });
    }
    return;
  }
  if (RND_MCP_TOOL_NAMES.has(name)) {
    try {
      const result = await handleRdRealtimeTool(name, args, sessionToken);
      outputJsonAndSpeakSummary(result);
    } catch (err) {
      outputJsonAndSpeakSummary({ ok: false, error: `R&D tool error: ${err.message}` });
      await appendRealtimeLog({ kind: 'rd_mcp_tool_error', sessionToken: sanitizeRealtimeSessionToken(sessionToken), toolName: name, error: err.message });
    }
    return;
  }
  if (name === 'openclaw_status' || name === 'openclaw_default_model') {
    try {
      const mcpResult = await callOpenClawMcpTool(name, args);
      outputAndSpeak(JSON.stringify(mcpResult));
      await appendRealtimeLog({ kind: 'local_mcp_tool_result', sessionToken: sanitizeRealtimeSessionToken(sessionToken), toolName: name, ok: mcpResult.ok, elapsedMs: mcpResult.elapsedMs, listedTools: mcpResult.listedTools });
    } catch (err) {
      outputAndSpeak(`Local OpenClaw MCP adapter error: ${err.message}`);
      await appendRealtimeLog({ kind: 'local_mcp_tool_error', sessionToken: sanitizeRealtimeSessionToken(sessionToken), toolName: name, error: err.message });
    }
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

async function startRealtimeSideband(location, sessionToken) {
  if (!REALTIME_SIDEBAND_ENABLED || !location || !getOpenAIApiKey()) return false;
  const key = sanitizeRealtimeSessionToken(sessionToken);
  const callId = realtimeCallIdFromLocation(location);
  const wsUrl = callId ? `wss://api.openai.com/v1/realtime?call_id=${encodeURIComponent(callId)}` : '';
  if (!wsUrl) return false;
  try {
    const existing = realtimeSidebands.get(key);
    if (existing?.readyState === WebSocket.OPEN || existing?.readyState === WebSocket.CONNECTING) existing.close();
    const ws = new WebSocket(wsUrl, { headers: { Authorization: `Bearer ${getOpenAIApiKey()}` } });
    realtimeSidebands.set(key, ws);
    let opened = false;
    const openPromise = new Promise((resolve) => {
      const timer = setTimeout(() => resolve(false), REALTIME_SIDEBAND_OPEN_TIMEOUT_MS);
      ws.once('open', () => { opened = true; clearTimeout(timer); resolve(true); });
      ws.once('error', () => { clearTimeout(timer); resolve(false); });
      ws.once('close', () => { clearTimeout(timer); resolve(false); });
    });
    ws.on('open', () => appendRealtimeLog({ kind: 'sideband_open', sessionToken: key, callIdPrefix: callId.slice(0, 8) }));
    ws.on('message', (data) => { let event; try { event = JSON.parse(data.toString()); } catch { return; } if (event.type === 'response.function_call_arguments.done') handleRealtimeSidebandToolCall(ws, event, key).catch((err) => appendRealtimeLog({ kind: 'sideband_tool_error', sessionToken: key, error: err.message })); });
    ws.on('close', (code, reason) => { if (realtimeSidebands.get(key) === ws) realtimeSidebands.delete(key); appendRealtimeLog({ kind: 'sideband_close', sessionToken: key, code, reason: String(reason || '') }); });
    ws.on('error', (err) => { if (!opened && realtimeSidebands.get(key) === ws) realtimeSidebands.delete(key); appendRealtimeLog({ kind: 'sideband_error', sessionToken: key, error: err.message }); });
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
  return `voice-realtime-${sanitizeRealtimeSessionToken(browserSessionId)}-julian`;
}

function realtimeRoutingMode(req) {
  const url = new URL(req.url, `http://localhost:${PORT}`);
  const value = String(url.searchParams.get('route') || req.headers['x-openclaw-route'] || '').toLowerCase();
  if (['direct-tools', 'native', 'native-tools', 'realtime-tools'].includes(value)) return 'direct-tools';
  if (['mcp', 'mcp-tools', 'tools'].includes(value)) return 'mcp-tools';
  if (['hybrid', 'mcp-openclaw', 'mcp+openclaw', 'mcp-openclaw-tools'].includes(value)) return 'mcp-openclaw';
  if (rdRouteModeIds().includes(value)) return value;
  return value === 'direct' || value === 'pure' || value === 'realtime-only' ? 'direct' : 'openclaw';
}

function isOpenClawRealtimeRoute(routeMode = '') {
  return routeMode === 'openclaw' || routeMode === 'mcp-openclaw' || String(routeMode || '').startsWith('openclaw-');
}

function hasServerOwnedRealtimeTools(routeMode = '') {
  return isOpenClawRealtimeRoute(routeMode) || routeMode === 'direct-tools' || routeMode === 'mcp-tools';
}

function realtimeInstructionsForRoute(routeMode = '') {
  if (routeMode === 'mcp-tools') return REALTIME_MCP_TOOLS_INSTRUCTIONS;
  if (routeMode === 'mcp-openclaw') return REALTIME_HYBRID_TOOLS_INSTRUCTIONS;
  if (isOpenClawRealtimeRoute(routeMode)) return REALTIME_INSTRUCTIONS;
  return routeMode === 'direct-tools' ? REALTIME_DIRECT_TOOLS_INSTRUCTIONS : REALTIME_DIRECT_INSTRUCTIONS;
}

function realtimeToolsForRoute(routeMode = '') {
  if (routeMode === 'openclaw-local-mcp') return LOCAL_OPENCLAW_MCP_TOOLS;
  if (routeMode === 'mcp-tools') return LOCAL_MCP_CALL_TOOLS;
  if (routeMode === 'mcp-openclaw') return [WEB_SEARCH_REALTIME_TOOL, ...LOCAL_MCP_CALL_TOOLS, ...REALTIME_TOOLS];
  if (isOpenClawRealtimeRoute(routeMode)) return [WEB_SEARCH_REALTIME_TOOL, ...REALTIME_TOOLS];
  if (routeMode === 'direct-tools') return DIRECT_REALTIME_TOOLS;
  return [];
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
  return Number(process.env.REALTIME_OPENCLAW_TIMEOUT_MS || 1200000);
}


async function steerRealtimeOpenClawTurn({ text, sessionToken, urgency, processing }) {
  const cleanedText = String(text || '').trim();
  if (!cleanedText) return { ok: false, error: 'empty steer text' };
  const key = sanitizeRealtimeSessionToken(sessionToken);
  const current = realtimeTurns.get(key);
  if (!current) return { ok: false, error: 'no active OpenClaw turn to steer' };
  const startedAt = Date.now();
  const result = await steerActiveReply(cleanedText, { processing: { ...(processing || {}), sessionToken: realtimeOpenClawSessionToken(key), fastMode: 'on' }, timeoutMs: 15000 });
  await appendRealtimeLog({ kind: 'steer', sessionToken: key, turnId: current.turnId, urgency: urgency || 'normal', ok: !!result.ok, elapsedMs: Date.now() - startedAt, text: cleanedText, error: result.error || '' });
  return { ok: !!result.ok, steered: !!result.ok, reply: result.ok ? 'Added that to the active OpenClaw request.' : undefined, sessionToken: key, turnId: current.turnId, activeSinceMs: Date.now() - current.startedAt, summary: result.ok ? 'Added that to the active OpenClaw request.' : `OpenClaw steering failed: ${result.error || 'unknown error'}`, error: result.error || undefined };
}

async function runRealtimeOpenClawTurn({ text, sessionToken, turnId, urgency, processing }) {
  const cleanedText = String(text || '').trim();
  if (!cleanedText) return { ok: false, error: 'empty text' };

  const key = sanitizeRealtimeSessionToken(sessionToken);
  if (realtimeTurns.has(key)) return await steerRealtimeOpenClawTurn({ text: cleanedText, sessionToken: key, urgency, processing });
  const controller = new AbortController();
  const openclawToken = realtimeOpenClawSessionToken(key);
  const effectiveTurnId = String(turnId || `rt-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`);
  realtimeTurns.set(key, { controller, turnId: effectiveTurnId, startedAt: Date.now() });

  await appendRealtimeLog({ kind: 'user', sessionToken: key, openclawSessionToken: openclawToken, turnId: effectiveTurnId, urgency: urgency || 'normal', text: cleanedText });

  try {
    const gatewayStartedAt = Date.now();
    const reply = await generateReply(cleanedText, {
      signal: controller.signal,
      processing: { ...(processing || {}), sessionToken: openclawToken, fastMode: 'on' },
      timeoutMs: realtimeVoiceTimeoutMs(urgency, processing || {}),
    });
    const timings = { gatewayMs: Date.now() - gatewayStartedAt, totalMs: Date.now() - realtimeTurns.get(key)?.startedAt };
    if (controller.signal.aborted || realtimeTurns.get(key)?.turnId !== effectiveTurnId) {
      await appendRealtimeLog({ kind: 'stale_reply_suppressed', sessionToken: key, turnId: effectiveTurnId });
      return { ok: false, cancelled: true, error: 'turn cancelled' };
    }
    if (realtimeTurns.get(key)?.turnId === effectiveTurnId) realtimeTurns.delete(key);
    const answer = reply || "I didn't catch that. Say it again.";
    await appendRealtimeLog({ kind: 'assistant', sessionToken: key, openclawSessionToken: openclawToken, turnId: effectiveTurnId, timings, text: answer });
    return { ok: true, reply: answer, sessionToken: key, openclawSessionToken: openclawToken, turnId: effectiveTurnId, timings };
  } catch (err) {
    if (realtimeTurns.get(key)?.turnId === effectiveTurnId) realtimeTurns.delete(key);
    if (err.message === 'aborted') {
      await appendRealtimeLog({ kind: 'cancelled', sessionToken: key, turnId: effectiveTurnId });
      return { ok: false, cancelled: true, error: 'turn cancelled' };
    }
    console.error('[realtime-openclaw]', err.message);
    await appendRealtimeLog({ kind: 'error', sessionToken: key, turnId: effectiveTurnId, error: err.message });
    return { ok: false, error: 'OpenClaw turn failed' };
  }
}

async function readRequestBody(req, limitBytes = 2_000_000) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > limitBytes) throw new Error('request body too large');
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString('utf8');
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
        product: 'VoiceClaw Bridge',
        auth: bridgeAuthSummary(),
        wsPath: `${BASE_PATH}/ws` || '/ws',
        realtimePath: `${BASE_PATH}/realtime/session` || '/realtime/session',
        processing: getProcessingOptions(),
        wakePhrase: WAKE_PHRASE,
        realtime: { model: REALTIME_MODEL, transcriptionModel: REALTIME_TRANSCRIPTION_MODEL, transcriptionDefault: REALTIME_TRANSCRIPTION_DEFAULT, transcriptionDelay: REALTIME_TRANSCRIPTION_DELAY, reasoningEffort: REALTIME_REASONING_EFFORT, reasoningOptions: ['low', 'medium', 'high'], voice: REALTIME_VOICE, bridge: true, sidebandEnabled: REALTIME_SIDEBAND_ENABLED, transcriptLog: REALTIME_TRANSCRIPT_LOG, turnDetectionDefault: REALTIME_TURN_DETECTION_MODE, turnDetectionOptions: ['semantic_vad', 'server_vad'], cloudAudioDefault: true, localPrivatePath: `${BASE_PATH}/index.html` || '/index.html', transcriptionOptions: ['off', REALTIME_TRANSCRIPTION_MODEL], conversationOptions: ['openclaw-gpt55', REALTIME_MODEL], routeModes: ['direct', 'direct-tools', 'openclaw', 'mcp-tools', 'mcp-openclaw', ...rdRouteModeIds()], experiments: describeRdFlags(), directTools: DIRECT_REALTIME_TOOLS.map(({ name, description }) => ({ name, description })), mcpTools: LOCAL_MCP_CALL_TOOLS.map(({ name, description }) => ({ name, description })), mcpToolCatalog: RND_MCP_TOOLS.map(({ name, description }) => ({ name, description })), openclawTools: REALTIME_TOOLS.map(({ name, description }) => ({ name, description })), localOpenClawMcpTools: LOCAL_OPENCLAW_MCP_TOOLS.map(({ name, description }) => ({ name, description })) },
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

    if (req.method === 'POST' && urlPath === `${BASE_PATH}/rd/web-search`) {
      const body = await readRequestBody(req, 50_000).catch(() => '{}');
      let payload;
      try { payload = JSON.parse(body || '{}'); } catch { payload = {}; }
      try {
        const result = await toolWebSearch(payload.arguments || payload || {});
        res.writeHead(result.ok ? 200 : 400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ adapter: 'server_realtime_web_search', ...result }));
      } catch (err) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: false, adapter: 'server_realtime_web_search', error: err.message }));
      }
      return;
    }

    if (req.method === 'POST' && urlPath === `${BASE_PATH}/rd/local-mcp-call`) {
      const body = await readRequestBody(req, 200_000).catch(() => '{}');
      let payload;
      try { payload = JSON.parse(body || '{}'); } catch { payload = {}; }
      const tool = String(payload.tool || '').trim();
      try {
        const result = await callOpenClawMcpTool(tool, normalizeLocalMcpArguments(payload));
        res.writeHead(result.ok ? 200 : 400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ adapter: 'local_mcp_call', ...result }));
      } catch (err) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: false, adapter: 'local_mcp_call', error: err.message }));
      }
      return;
    }

    if (req.method === 'POST' && urlPath === `${BASE_PATH}/rd/local-mcp-tool`) {
      const body = await readRequestBody(req, 50_000).catch(() => '{}');
      let payload;
      try { payload = JSON.parse(body || '{}'); } catch { payload = {}; }
      const tool = payload.tool || 'openclaw_status';
      try {
        const result = await callOpenClawMcpTool(tool, normalizeLocalMcpArguments(payload));
        res.writeHead(result.ok ? 200 : 502, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(result));
      } catch (err) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: false, error: err.message }));
      }
      return;
    }

    if (req.method === 'POST' && urlPath === `${BASE_PATH}/rd/realtime-tool`) {
      const body = await readRequestBody(req, 200_000).catch(() => '{}');
      let payload;
      try { payload = JSON.parse(body || '{}'); } catch { payload = {}; }
      const toolName = String(payload.tool || '').trim();
      if (!RND_MCP_TOOL_NAMES.has(toolName)) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: false, error: `unsupported R&D realtime tool: ${toolName}` }));
        return;
      }
      try {
        const result = await handleRdRealtimeTool(toolName, normalizeLocalMcpArguments(payload), payload.sessionToken || 'browser-fallback');
        res.writeHead(result.ok ? 200 : 400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(result));
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
      const result = await steerRealtimeOpenClawTurn({ ...payload, text: gate.text });
      res.writeHead(result.ok ? 200 : 409, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(result));
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
        result = await runRealtimeOpenClawTurn({ ...payload, text: gate.text });
      } finally {
        decrementRealtimeQueue(payload.sessionToken);
      }
      res.writeHead(result.ok ? 200 : (result.cancelled ? 409 : 400), { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ...result, queue: { pending: realtimeQueueCount(payload.sessionToken), max: MAX_REALTIME_PENDING_TURNS } }));
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
      const cancelled = cancelRealtimeTurn(key, payload.reason || 'client disconnect', '', { force: true });
      const sidebandClosed = closeRealtimeSideband(key, payload.reason || 'client disconnect');
      await appendRealtimeLog({ kind: 'realtime_session_disconnected', sessionToken: key, cancelled, sidebandClosed });
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true, cancelled, sidebandClosed }));
      return;
    }


    if (req.method === 'GET' && urlPath === `${BASE_PATH}/realtime/status`) {
      const url = new URL(req.url, `http://localhost:${PORT}`);
      const sessionToken = url.searchParams.get('sessionToken') || req.headers['x-voice-session-token'] || '';
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true, ...bridgeStatusSnapshot(sessionToken) }));
      return;
    }

    if (req.method === 'POST' && urlPath === `${BASE_PATH}/realtime/session`) {
      const routeMode = realtimeRoutingMode(req);
      const apiKey = getOpenAIApiKey();
      if (!apiKey) {
        res.writeHead(503, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: false, error: 'OpenAI API key is not configured on the server' }));
        return;
      }

      const sessionToken = req.headers['x-voice-session-token'] || `browser-${Date.now().toString(36)}`;
      const options = realtimeRequestOptions(req, routeMode, sessionToken);
      realtimeSessionConfigs.set(options.sessionToken, options);
      const sdpOffer = await readRequestBody(req);
      const fd = new FormData();
      fd.set('sdp', sdpOffer);
      const realtimeSession = {
        type: 'realtime',
        model: REALTIME_MODEL,
        reasoning: { effort: options.realtimeReasoning },
        instructions: realtimeInstructionsForRoute(routeMode),
        audio: buildRealtimeAudioConfig(options),
      };
      if (routeMode === 'openclaw-local-mcp') {
        realtimeSession.instructions = `${REALTIME_INSTRUCTIONS}\n\n# R&D local MCP route\n- For requests about OpenClaw runtime status or configured model, call openclaw_status or openclaw_default_model.\n- These tools are executed by the server-side local MCP adapter using the official MCP SDK over stdio.\n- Do not claim broader OpenClaw tool access in this R&D route.`;
        realtimeSession.tools = LOCAL_OPENCLAW_MCP_TOOLS;
        realtimeSession.tool_choice = 'auto';
      } else if (routeMode !== 'direct') {
        realtimeSession.tools = realtimeToolsForRoute(routeMode);
        realtimeSession.tool_choice = 'auto';
      } else {
        realtimeSession.tool_choice = 'none';
      }
      fd.set('session', JSON.stringify(realtimeSession));

      const upstream = await fetch('https://api.openai.com/v1/realtime/calls', {
        method: 'POST',
        headers: { Authorization: `Bearer ${apiKey}` },
        body: fd,
      });
      const body = await upstream.text();
      const location = upstream.headers.get('location') || upstream.headers.get('Location') || '';
      const sidebandStarted = hasServerOwnedRealtimeTools(routeMode) && upstream.ok && location ? await startRealtimeSideband(location, sessionToken) : false;
      if (upstream.ok) await appendRealtimeLog({ kind: 'realtime_session_created', sessionToken: sanitizeRealtimeSessionToken(sessionToken), routeMode, sidebandLocationHeader: !!location, sidebandStarted, options: { captions: options.captions, turnDetection: options.turnDetection, realtimeReasoning: options.realtimeReasoning, transcriptionDelay: options.transcriptionDelay } });
      const headers = { 'Content-Type': upstream.ok ? 'application/sdp' : 'text/plain' };
      if (location) headers['X-OpenAI-Realtime-Location'] = 'present';
      headers['X-OpenClaw-Route'] = routeMode;
      if (sidebandStarted) headers['X-OpenClaw-Sideband'] = 'started';
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
