const $ = (selector) => document.querySelector(selector);
const els = {
  connect: $('#connectRealtimeButton'),
  connectTitle: $('#connectRealtimeButton .talk-title'),
  disconnect: $('#disconnectRealtimeButton'),
  mute: $('#muteRealtimeButton'),
  stopOpenClaw: $('#stopOpenClawButton'),
  newSession: $('#newRealtimeSessionButton'),
  status: $('#realtimeStatus'),
  model: $('#realtimeModel'),
  bridge: $('#realtimeBridgeChip'),
  routeSelect: $('#realtimeRouteSelect'),
  routeNote: $('#realtimeRouteNote'),
  modelSelect: $('#realtimeModelSelect'),
  thinkingSelect: $('#realtimeThinkingSelect'),
  realtimeReasoningSelect: $('#realtimeReasoningSelect'),
  turnDetectionSelect: $('#turnDetectionSelect'),
  liveCaptionsToggle: $('#liveCaptionsToggle'),
  bridgeState: $('#bridgeStateChip'),
  audio: $('#realtimeAudio'),
  log: $('#realtimeLog'),
  clear: $('#clearRealtimeLog'),
};

const sessionStorageKey = 'voice-bridge-realtime-session-token-v1';
const transcriptStorageKey = 'voice-bridge-realtime-transcript-v3';
const realtimeRouteStorageKey = 'voice-bridge-realtime-route-v1';
const realtimeSettingsStorageKey = 'voice-bridge-realtime-settings-v1';
const pageParams = new URLSearchParams(window.location.search);
const embeddedMode = ['1', 'true', 'yes', 'app'].includes(String(pageParams.get('embedded') || '').toLowerCase());
const PROCESSING_DEFAULT_VERSION = 'openclaw-tools-gpt55-minimal-2026-05-06';
const LEGACY_DEFAULT_PROCESSING_AGENTS = new Set(['julian', 'default', 'default-fast', 'intercom', 'gpt54', 'gpt54-fast', 'gpt-5.4', 'chat-latest']);
const MAX_PENDING_TOOL_CALLS = 3;
const BASE_REALTIME_ROUTE_MODES = ['direct', 'direct-tools', 'openclaw', 'mcp-tools', 'mcp-openclaw'];
const EXPERIMENTAL_ROUTE_LABELS = {
  direct: 'None',
  'direct-tools': 'GPT‑Realtime‑2 Native Tools',
  openclaw: 'OpenClaw Tools',
  'mcp-tools': 'MCP Tools',
  'mcp-openclaw': 'MCP Tools + OpenClaw Tools',
  'openclaw-mcp': 'OpenClaw Bridge — direct Realtime MCP tools (R&D)',
  'openclaw-responses-sidecar': 'OpenClaw Bridge — Responses sidecar function tool (R&D)',
};
let availableRealtimeRouteModes = [...BASE_REALTIME_ROUTE_MODES];

let pc = null;
let dc = null;
let micStream = null;
let config = null;
let activeToolCall = null;
let pendingToolCalls = [];
let sessionToken = loadSessionToken();
let processing = loadProcessingConfig();
let routeMode = loadRealtimeRouteMode();
let muted = false;
let lastUserTranscript = { text: '', at: 0 };
let lastSpeechStartedAt = 0;
let lastToolCall = { text: '', at: 0 };
let lastOpenClawTimings = null;
let lastAssistantTranscript = { text: '', at: 0 };
let prewarmTimer = null;
let sidebandToolOwner = false;
let serverBridgeStatus = { active: false, sideband: 'none' };
let statusPollTimer = null;
let realtimeSettings = loadRealtimeSettings();

function makeToken() {
  return `browser-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}


function loadRealtimeSettings() {
  try {
    const saved = JSON.parse(localStorage.getItem(realtimeSettingsStorageKey) || '{}');
    return {
      realtimeReasoning: ['low', 'medium', 'high'].includes(saved.realtimeReasoning) ? saved.realtimeReasoning : 'high',
      turnDetection: ['semantic_vad', 'server_vad'].includes(saved.turnDetection) ? saved.turnDetection : 'semantic_vad',
      liveCaptions: !!saved.liveCaptions,
      transcriptionDelay: ['minimal', 'low', 'medium', 'high', 'xhigh'].includes(saved.transcriptionDelay) ? saved.transcriptionDelay : 'low',
    };
  } catch {
    return { realtimeReasoning: 'high', turnDetection: 'semantic_vad', liveCaptions: false, transcriptionDelay: 'low' };
  }
}

function saveRealtimeSettings() {
  try { localStorage.setItem(realtimeSettingsStorageKey, JSON.stringify(realtimeSettings)); } catch {}
}

function loadSessionToken() {
  const existing = localStorage.getItem(sessionStorageKey);
  if (existing) return existing;
  const token = makeToken();
  localStorage.setItem(sessionStorageKey, token);
  return token;
}

function loadProcessingConfig() {
  try {
    const saved = JSON.parse(localStorage.getItem('voice-bridge-realtime-processing-v1') || '{}');
    let agent = saved.agent || '';
    // Migrate stale saved selections to the current server-selected default.
    // After the user changes the selector, the version is persisted and that
    // explicit choice is honored.
    const isStaleDefault = saved.processingDefaultVersion !== PROCESSING_DEFAULT_VERSION;
    if (isStaleDefault || !agent || LEGACY_DEFAULT_PROCESSING_AGENTS.has(agent)) agent = '';
    return { agent, thinking: isStaleDefault ? '' : (saved.thinking || ''), fastMode: 'on' };
  } catch {
    return { agent: '', thinking: '', fastMode: 'on' };
  }
}

function loadRealtimeRouteMode() {
  try {
    const saved = localStorage.getItem(realtimeRouteStorageKey);
    return BASE_REALTIME_ROUTE_MODES.includes(saved) ? saved : 'openclaw';
  } catch {
    return 'openclaw';
  }
}

function isOpenClawRouteMode(mode = routeMode) {
  return mode === 'openclaw' || mode === 'mcp-openclaw' || String(mode || '').startsWith('openclaw-');
}

function usesOpenClawProcessingControls(mode = routeMode) {
  // The local MCP R&D route exposes fixed server-owned MCP tools directly to
  // Realtime. It does not route through openclaw_turn, so the OpenClaw model /
  // reasoning controls are intentionally irrelevant there.
  return mode === 'openclaw' || mode === 'mcp-openclaw' || mode === 'openclaw-responses-sidecar';
}

function routeInputs() {
  return els.routeSelect ? [...els.routeSelect.querySelectorAll('input[name="realtimeTools"]')] : [];
}

function selectedRouteInputValue() {
  return routeInputs().find((input) => input.checked)?.value || routeMode;
}

function syncRouteOptions(routeModes = availableRealtimeRouteModes) {
  availableRealtimeRouteModes = [...new Set([...BASE_REALTIME_ROUTE_MODES, ...(routeModes || [])])];
  if (!els.routeSelect) return;
  const existing = new Set(routeInputs().map((input) => input.value));
  for (const mode of availableRealtimeRouteModes) {
    if (existing.has(mode)) continue;
    const label = document.createElement('label');
    const input = document.createElement('input');
    input.type = 'radio';
    input.name = 'realtimeTools';
    input.value = mode;
    input.addEventListener('change', updateRouteFromInput);
    const span = document.createElement('span');
    span.textContent = EXPERIMENTAL_ROUTE_LABELS[mode] || mode;
    label.append(input, span);
    els.routeSelect.appendChild(label);
  }
  if (!availableRealtimeRouteModes.includes(routeMode)) routeMode = 'openclaw';
  for (const input of routeInputs()) input.checked = input.value === routeMode;
}

function saveRealtimeRouteMode() {
  try { localStorage.setItem(realtimeRouteStorageKey, routeMode); } catch {}
}

function saveProcessingConfig() {
  localStorage.setItem('voice-bridge-realtime-processing-v1', JSON.stringify({ agent: processing.agent, thinking: processing.thinking, fastMode: 'on', processingDefaultVersion: PROCESSING_DEFAULT_VERSION }));
}

function setSessionToken(token) {
  sessionToken = token || makeToken();
  localStorage.setItem(sessionStorageKey, sessionToken);
}

function normalizeTranscriptText(text = '') {
  return String(text || '').trim().replace(/\s+/g, ' ');
}

function saveTranscriptEntry(kind, text, data = {}) {
  const clean = normalizeTranscriptText(text);
  if (!clean) return null;
  const entry = { ts: new Date().toISOString(), kind, text: clean, ...data };
  const entries = JSON.parse(localStorage.getItem(transcriptStorageKey) || '[]');
  entries.push(entry);
  localStorage.setItem(transcriptStorageKey, JSON.stringify(entries.slice(-200)));
  renderTranscriptEntry(entry);
  return entry;
}

function renderTranscriptEntry(entry) {
  if (!entry?.text) return;
  if (els.log.querySelector('.placeholder')) els.log.textContent = '';
  const row = document.createElement('div');
  row.className = `voice-row ${entry.kind === 'user' ? 'from-user' : entry.kind === 'assistant' ? 'from-assistant' : 'from-system'}`;

  const bubble = document.createElement('div');
  bubble.className = 'voice-bubble';

  const meta = document.createElement('div');
  meta.className = 'voice-meta';
  const label = entry.kind === 'user' ? 'You' : 'Assistant';
  meta.textContent = `${label} · ${new Date(entry.ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}`;

  const text = document.createElement('div');
  text.className = 'voice-text';
  text.textContent = entry.text;

  bubble.append(meta, text);
  row.appendChild(bubble);
  els.log.appendChild(row);
  els.log.scrollTop = els.log.scrollHeight;
}

function restoreTranscript() {
  try {
    const entries = JSON.parse(localStorage.getItem(transcriptStorageKey) || '[]');
    if (!entries.length) return;
    els.log.textContent = '';
    for (const entry of entries.slice(-60)) renderTranscriptEntry(entry);
  } catch {}
}

function log(message, data, kind = 'event') {
  // Keep operational metadata out of the public transcript panel.
  console.debug('[realtime]', message, data || '');
  if (kind === 'user' || kind === 'assistant' || kind === 'system') {
    saveTranscriptEntry(kind, typeof data === 'string' ? data : message);
  }
}

function rememberUserTranscript(text) {
  const clean = normalizeTranscriptText(text);
  if (!clean) return;
  lastUserTranscript = { text: clean, at: Date.now() };
  saveTranscriptEntry('user', clean, { source: 'input_audio_transcription' });
}

function recentUserTranscriptText(maxAgeMs = 12000, minAt = 0) {
  if (!lastUserTranscript.text) return '';
  if (lastUserTranscript.at < minAt) return '';
  if ((Date.now() - lastUserTranscript.at) > maxAgeMs) return '';
  return lastUserTranscript.text;
}

async function waitForRecentUserTranscript(timeoutMs = 220, minAt = 0) {
  const existing = recentUserTranscriptText(12000, minAt);
  if (existing) return existing;
  const start = Date.now();
  while ((Date.now() - start) < timeoutMs) {
    await new Promise((resolve) => setTimeout(resolve, 40));
    const current = recentUserTranscriptText(12000, minAt);
    if (current) return current;
  }
  return '';
}

function normalizedToolText(text = '') {
  return normalizeTranscriptText(text).toLowerCase();
}

function exactSpeakInstruction(text = '') {
  return `Say exactly this text and nothing else:
${String(text || '').trim()}`;
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

function saveAssistantTranscript(text, data = {}) {
  const clean = normalizeTranscriptText(text);
  if (!clean) return null;
  const normalized = clean.toLowerCase();
  if (lastAssistantTranscript.text === normalized && (Date.now() - lastAssistantTranscript.at) < 20000) return null;
  lastAssistantTranscript = { text: normalized, at: Date.now() };
  return saveTranscriptEntry('assistant', clean, data);
}

function shouldSuppressAssistantAudioTranscript(text = '') {
  const normalized = normalizeTranscriptText(text).toLowerCase();
  return !!normalized && normalized === lastAssistantTranscript.text && (Date.now() - lastAssistantTranscript.at) < 20000;
}

function setConnectLabel(text) {
  if (els.connectTitle) els.connectTitle.textContent = text;
}

function setRealtimeVisualPhase(visual) {
  const next = visual || 'idle';
  document.body.classList.remove('voice-state-idle', 'voice-state-live', 'voice-state-listening', 'voice-state-transcribing', 'voice-state-processing', 'voice-state-speaking', 'voice-state-connecting', 'voice-state-error');
  document.body.classList.add(`voice-state-${next}`);
  document.body.dataset.voiceState = next;
}

function realtimeVisualForStatus(text = '') {
  const normalized = String(text || '').toLowerCase();
  if (normalized.includes('asking openclaw') || normalized.includes('processing')) return 'processing';
  if (normalized.includes('transcrib')) return 'transcribing';
  if (normalized.includes('speech') || normalized.includes('listening')) return 'listening';
  if (normalized.includes('speaking')) return 'speaking';
  if (normalized === 'connected' || normalized === 'live') return 'live';
  if (normalized === 'connecting') return 'connecting';
  if (normalized === 'error' || normalized === 'failed') return 'error';
  return 'idle';
}

function setStatus(text) {
  const displayText = String(text || '').toLowerCase().includes('asking openclaw') ? 'ASKING OPENCLAW' : text;
  els.status.textContent = displayText;
  const halo = document.querySelector('#realtimeHalo');
  const visual = realtimeVisualForStatus(text);
  if (halo) {
    halo.classList.remove('state-idle', 'state-connecting', 'state-live', 'state-blocked', 'state-speaking-local', 'state-speaking-remote');
    const haloClass = visual === 'live' || visual === 'listening' ? 'state-live'
      : visual === 'processing' || visual === 'transcribing' || visual === 'connecting' ? 'state-connecting'
      : visual === 'speaking' ? 'state-speaking-remote'
      : visual === 'error' ? 'state-blocked'
      : 'state-idle';
    halo.classList.add(haloClass);
  }
  setRealtimeVisualPhase(visual);
}

function applyEmbeddedMode() {
  document.body.classList.toggle('embedded-mode', embeddedMode);
}

function apiPath(path) {
  const base = new URL('.', window.location.href);
  return new URL(path.replace(/^\/+/, ''), base).pathname;
}

function prettyModelLabel(value = '') {
  const text = String(value || '');
  if (/chat-latest/i.test(text)) return 'GPT-5.5 Instant (chat-latest)';
  const raw = text.replace(/^openai-codex\//, '').replace(/^openai\//, '').replace(/^gpt-/, 'GPT ');
  return raw
    .split('-')
    .map((part) => {
      if (/^gpt$/i.test(part)) return 'GPT';
      if (/^\d+(?:\.\d+)?$/.test(part)) return part;
      return part.charAt(0).toUpperCase() + part.slice(1);
    })
    .join(' ')
    .replace(/^GPT\s+/, 'GPT ');
}

function prettyReasoningLabel(value = '') {
  const text = String(value || '');
  return text.charAt(0).toUpperCase() + text.slice(1);
}

async function loadConfig() {
  const response = await fetch(apiPath('/config'));
  config = await response.json();
  if (config.realtime) {
    syncRouteOptions(config.realtime.routeModes || BASE_REALTIME_ROUTE_MODES);
    realtimeSettings.realtimeReasoning = realtimeSettings.realtimeReasoning || config.realtime.reasoningEffort || 'high';
    realtimeSettings.turnDetection = realtimeSettings.turnDetection || config.realtime.turnDetectionDefault || 'semantic_vad';
    syncRealtimeSettingsUi(config.realtime);
  }
  renderProcessingControls(config.processing || {});
  return config;
}


function syncRealtimeSettingsUi(realtime = {}) {
  const reasoningOptions = realtime.reasoningOptions || ['low', 'medium', 'high'];
  if (!reasoningOptions.includes(realtimeSettings.realtimeReasoning)) realtimeSettings.realtimeReasoning = realtime.reasoningEffort || reasoningOptions.at(-1) || 'high';
  if (els.realtimeReasoningSelect) {
    els.realtimeReasoningSelect.innerHTML = '';
    for (const level of reasoningOptions) {
      const option = document.createElement('option');
      option.value = level;
      option.textContent = prettyReasoningLabel(level);
      els.realtimeReasoningSelect.appendChild(option);
    }
    els.realtimeReasoningSelect.value = realtimeSettings.realtimeReasoning;
  }

  const vadOptions = realtime.turnDetectionOptions || ['semantic_vad', 'server_vad'];
  if (!vadOptions.includes(realtimeSettings.turnDetection)) realtimeSettings.turnDetection = realtime.turnDetectionDefault || vadOptions[0] || 'semantic_vad';
  if (els.turnDetectionSelect) {
    els.turnDetectionSelect.innerHTML = '';
    const labels = { semantic_vad: 'Semantic VAD — natural turns', server_vad: 'Server VAD — faster silence cut' };
    for (const mode of vadOptions) {
      const option = document.createElement('option');
      option.value = mode;
      option.textContent = labels[mode] || mode;
      els.turnDetectionSelect.appendChild(option);
    }
    els.turnDetectionSelect.value = realtimeSettings.turnDetection;
  }

  if (els.liveCaptionsToggle) els.liveCaptionsToggle.checked = !!realtimeSettings.liveCaptions;
  saveRealtimeSettings();
  updateBridgeStateChip();
}

function updateRealtimeSettingsFromInputs() {
  if (els.realtimeReasoningSelect) realtimeSettings.realtimeReasoning = els.realtimeReasoningSelect.value || realtimeSettings.realtimeReasoning;
  if (els.turnDetectionSelect) realtimeSettings.turnDetection = els.turnDetectionSelect.value || realtimeSettings.turnDetection;
  if (els.liveCaptionsToggle) realtimeSettings.liveCaptions = !!els.liveCaptionsToggle.checked;
  saveRealtimeSettings();
  updateBridgeStateChip();
  saveTranscriptEntry('system', `Realtime settings updated: ${realtimeSettings.realtimeReasoning} reasoning, ${realtimeSettings.turnDetection.replace('_', ' ')}, captions ${realtimeSettings.liveCaptions ? 'on' : 'off'}.`);
}

function updateBridgeStateChip() {
  if (!els.bridgeState) return;
  const mode = routeMode === 'direct' ? 'Pure Realtime‑2'
    : routeMode === 'direct-tools' ? (sidebandToolOwner ? 'Native tools sideband' : 'Native tools browser fallback')
    : routeMode === 'mcp-tools' ? (sidebandToolOwner ? 'MCP tools sideband' : 'MCP tools browser fallback')
    : routeMode === 'mcp-openclaw' ? (sidebandToolOwner ? 'MCP + OpenClaw sideband' : 'MCP + OpenClaw browser fallback')
    : routeMode === 'openclaw-local-mcp' ? (sidebandToolOwner ? 'Local MCP sideband' : 'Local MCP browser fallback')
    : (sidebandToolOwner ? 'OpenClaw sideband' : 'OpenClaw browser fallback');
  const active = serverBridgeStatus.active ? ' · active' : '';
  const captions = realtimeSettings.liveCaptions ? ' · captions' : '';
  els.bridgeState.textContent = `${mode}${active} · ${realtimeSettings.turnDetection.replace('_', ' ')}${captions}`;
}

function renderProcessingControls(options = {}) {
  const agents = options.agents || [];
  const thinking = options.thinking || ['off', 'minimal', 'low', 'medium', 'high'];
  if (!processing.agent) processing.agent = options.defaultAgent || agents[0]?.id || '';
  if (!thinking.includes(processing.thinking)) processing.thinking = options.defaultThinking || 'minimal';

  if (els.modelSelect) {
    els.modelSelect.innerHTML = '';
    for (const agent of agents) {
      const option = document.createElement('option');
      option.value = agent.id;
      option.textContent = prettyModelLabel(agent.label || agent.id);
      els.modelSelect.appendChild(option);
    }
    if (processing.agent) els.modelSelect.value = processing.agent;
  }

  if (els.thinkingSelect) {
    els.thinkingSelect.innerHTML = '';
    for (const level of thinking) {
      const option = document.createElement('option');
      option.value = level;
      option.textContent = prettyReasoningLabel(level);
      els.thinkingSelect.appendChild(option);
    }
    els.thinkingSelect.value = processing.thinking;
  }

  // Persist migrations immediately so stale medium/chat-latest defaults do not
  // keep reappearing on every realtime page load.
  saveProcessingConfig();
  syncRouteUi();
}

function syncRouteUi() {
  syncRouteOptions();
  for (const input of routeInputs()) input.checked = input.value === routeMode;
  const openclaw = isOpenClawRouteMode(routeMode);
  const openclawProcessing = usesOpenClawProcessingControls(routeMode);
  if (els.modelSelect) els.modelSelect.disabled = !openclawProcessing;
  if (els.thinkingSelect) els.thinkingSelect.disabled = !openclawProcessing;
  document.body.classList.toggle('realtime-direct-mode', !openclaw);
  if (els.stopOpenClaw) els.stopOpenClaw.classList.toggle('ui-hidden', !openclawProcessing);
  if (els.routeNote) els.routeNote.textContent = routeMode === 'direct'
    ? 'Tools: None. GPT‑Realtime‑2 handles the conversation itself with no attached tools.'
    : routeMode === 'direct-tools'
      ? 'Tools: GPT‑Realtime‑2 Server Tools. Includes server-owned web_search plus lightweight status/silence tools; no OpenClaw bridge and no MCP/local computer tools.'
      : routeMode === 'mcp-tools'
        ? 'Tools: MCP Tools. GPT‑Realtime‑2 can directly use the visible R&D tools: arrange apps, screen summary, project notes, R&D tasks, Codex task briefs, browser actions, and dashboard card opening/screenshot delivery. No OpenClaw bridge.'
        : routeMode === 'mcp-openclaw'
          ? 'Tools: MCP + full OpenClaw runtime. Realtime has server-owned web_search, local_mcp_call, and openclaw_turn; openclaw_turn hands heavier work to the local OpenClaw agent with its normal broad tools, files, browser, shell, memory, crons, sessions, subagents, coding/research, and dashboard authority.'
      : routeMode === 'openclaw-mcp'
        ? 'R&D mode: OpenClaw bridge semantics with a patch point for direct Realtime MCP tool catalogs. Disabled unless server flags enable it.'
        : routeMode === 'openclaw-responses-sidecar'
          ? 'R&D mode: OpenClaw bridge semantics with a patch point for a Responses sidecar function tool. Disabled unless server flags enable it.'
          : routeMode === 'openclaw-local-mcp'
            ? 'R&D local MCP mode: GPT‑Realtime‑2 calls fixed server-owned MCP tools through the sideband. OpenClaw model/reasoning controls are disabled because this route does not use openclaw_turn.'
            : 'Tools: OpenClaw. GPT‑Realtime‑2 handles live voice and uses the OpenClaw sideband for tools, memory, files, sessions, browser, crons, and heavier reasoning.';
  updateBridgeStateChip();
}

function updateRouteFromInput() {
  const requested = selectedRouteInputValue();
  routeMode = availableRealtimeRouteModes.includes(requested) ? requested : 'openclaw';
  saveRealtimeRouteMode();
  syncRouteUi();
  saveTranscriptEntry('system', routeMode === 'direct'
    ? 'Tools set: None.'
    : routeMode === 'direct-tools'
      ? 'Tools set: GPT‑Realtime‑2 Native Tools only.'
      : routeMode === 'mcp-tools'
        ? 'Tools set: MCP Tools only.'
        : routeMode === 'mcp-openclaw'
          ? 'Tools set: MCP Tools + full OpenClaw runtime bridge.'
      : routeMode === 'openclaw-local-mcp'
        ? 'Realtime mode set: local MCP sideband tools. OpenClaw tool-reasoning controls disabled for this route.'
        : 'Tools set: OpenClaw Tools.');
}

function updateProcessingFromInputs() {
  if (els.modelSelect) processing.agent = els.modelSelect.value || processing.agent;
  if (els.thinkingSelect) processing.thinking = els.thinkingSelect.value || processing.thinking;
  processing.fastMode = 'on';
  saveProcessingConfig();
  console.debug('[realtime] processing updated', processing);
}

async function prewarmOpenClawNow() {
  if (!isOpenClawRouteMode(routeMode)) return null;
  try {
    const response = await fetch(apiPath('/realtime/prewarm'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sessionToken, processing }),
    });
    const result = await response.json().catch(() => ({}));
    console.debug('[realtime] prewarm', response.status, result);
    return result;
  } catch (error) {
    console.debug('[realtime] prewarm failed', error.message);
    return null;
  }
}

function schedulePrewarm(delayMs = 250) {
  if (prewarmTimer) clearTimeout(prewarmTimer);
  prewarmTimer = setTimeout(() => { prewarmTimer = null; prewarmOpenClawNow(); }, delayMs);
}

function sendRealtimeEvent(event) {
  if (!dc || dc.readyState !== 'open') return false;
  dc.send(JSON.stringify(event));
  return true;
}


window.__realtimeTestSendText = function realtimeTestSendText(text) {
  const clean = String(text || '').trim();
  if (!clean) return false;
  return sendRealtimeEvent({
    type: 'conversation.item.create',
    item: { type: 'message', role: 'user', content: [{ type: 'input_text', text: clean }] },
  }) && sendRealtimeEvent({ type: 'response.create' });
};

window.__realtimeTestStatus = function realtimeTestStatus() {
  return { routeMode, sessionToken, connected: !!dc && dc.readyState === 'open', sidebandToolOwner, status: els.status?.textContent || '' };
};

function updateStopOpenClawState() {
  if (!els.stopOpenClaw) return;
  if (!isOpenClawRouteMode(routeMode)) {
    els.stopOpenClaw.disabled = true;
    els.stopOpenClaw.classList.remove('active');
    return;
  }
  const canStop = !!activeToolCall || pendingToolCalls.length > 0 || !!serverBridgeStatus.active;
  els.stopOpenClaw.disabled = !canStop;
  els.stopOpenClaw.classList.toggle('active', canStop);
}

function applyMuteState() {
  if (micStream) {
    for (const track of micStream.getAudioTracks()) track.enabled = !muted;
  }
  if (els.mute) {
    els.mute.textContent = 'Mute';
    els.mute.classList.toggle('active', muted);
    els.mute.setAttribute('aria-pressed', String(muted));
  }
}

function toggleMute() {
  muted = !muted;
  applyMuteState();
  console.debug('[realtime] mic muted=', muted);
}

async function cancelActiveTurn(reason = 'realtime interruption', { resolveToolCall = false, force = false } = {}) {
  const cancelled = activeToolCall;
  activeToolCall = null;
  const result = await fetch(apiPath('/realtime/cancel'), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ sessionToken, reason, turnId: cancelled?.turnId || '', force: force || !cancelled }),
  }).then((r) => r.json()).catch(() => ({ ok: false, cancelled: false }));
  if (resolveToolCall && cancelled?.callId) {
    sendRealtimeEvent({
      type: 'conversation.item.create',
      item: { type: 'function_call_output', call_id: cancelled.callId, output: 'Stopped.' },
    });
    sendRealtimeEvent({ type: 'response.create', response: { instructions: 'Say exactly: Stopped.' } });
    saveAssistantTranscript('Stopped.', { turnId: cancelled.turnId, stopped: true });
  }
  console.debug('[realtime] cancel OpenClaw request', { cancelled, result });
  serverBridgeStatus.active = false;
  updateBridgeStateChip();
  updateStopOpenClawState();
  return !!(cancelled || result.cancelled);
}

async function stopOpenClawNow() {
  const hadPending = pendingToolCalls.length > 0;
  pendingToolCalls = [];
  const cancelled = await cancelActiveTurn('manual stop', { resolveToolCall: true, force: true });
  if (!cancelled && hadPending) saveAssistantTranscript('Stopped.');
  sendRealtimeEvent({ type: 'response.cancel' });
  if (pc?.connectionState === 'connected') setStatus('connected');
  updateStopOpenClawState();
}

function sendFunctionOutput(callId, output, instructions = '', { transcript = false, transcriptText = '', transcriptData = {} } = {}) {
  const cleanOutput = String(output || '').trim();
  sendRealtimeEvent({
    type: 'conversation.item.create',
    item: { type: 'function_call_output', call_id: callId, output: cleanOutput },
  });
  if (transcript) saveAssistantTranscript(transcriptText || cleanOutput, transcriptData);
  if (instructions) sendRealtimeEvent({ type: 'response.create', response: { instructions } });
}

function bridgeStatusText() {
  if (routeMode === 'direct') return `Bridge connected: ${pc?.connectionState || 'disconnected'}. Mode: Pure GPT-Realtime-2. Tools: none. Mic muted: ${muted ? 'yes' : 'no'}.`;
  if (routeMode === 'direct-tools') return `Bridge connected: ${pc?.connectionState || 'disconnected'}. Mode: GPT-Realtime-2 with native Realtime tools. Sideband: ${serverBridgeStatus.sideband || 'unknown'}. Tool choice: auto. OpenClaw: disabled. Mic muted: ${muted ? 'yes' : 'no'}.`;
  if (routeMode === 'mcp-tools') return `Bridge connected: ${pc?.connectionState || 'disconnected'}. Mode: MCP Tools. Sideband: ${serverBridgeStatus.sideband || 'unknown'}. Tools: app arrangement, screen summary, notes, R&D tasks, Codex task briefs, browser actions, dashboard card opening/screenshot delivery. OpenClaw: disabled. Mic muted: ${muted ? 'yes' : 'no'}.`;
  if (routeMode === 'mcp-openclaw') return `Bridge connected: ${pc?.connectionState || 'disconnected'}. Mode: MCP Tools plus full OpenClaw runtime bridge. Sideband: ${serverBridgeStatus.sideband || 'unknown'}. openclaw_turn may invoke OpenClaw's normal broad local tool/session authority; Realtime only sees the bridge. Tool choice: auto. Mic muted: ${muted ? 'yes' : 'no'}.`;
  const rdMode = routeMode !== 'openclaw' ? ` R&D route: ${routeMode}.` : '';
  const model = els.modelSelect?.selectedOptions?.[0]?.textContent || processing.agent || 'default';
  const reasoning = els.thinkingSelect?.value || processing.thinking || 'medium';
  const active = activeToolCall || serverBridgeStatus.active ? 'yes' : 'no';
  const queued = pendingToolCalls.length || serverBridgeStatus.realtimePending || 0;
  const latency = lastOpenClawTimings?.totalMs ? `${Math.round(lastOpenClawTimings.totalMs / 100) / 10}s` : 'none yet';
  return `Bridge connected: ${pc?.connectionState || 'disconnected'}.${rdMode} Sideband: ${serverBridgeStatus.sideband || 'unknown'}. Model: ${model}. OpenClaw reasoning: ${reasoning}. Realtime reasoning: ${realtimeSettings.realtimeReasoning}. VAD: ${realtimeSettings.turnDetection}. Captions: ${realtimeSettings.liveCaptions ? 'on' : 'off'}. Active OpenClaw turn: ${active}. Queued: ${queued}. Mic muted: ${muted ? 'yes' : 'no'}. Last OpenClaw latency: ${latency}.`;
}

const RND_MCP_TOOL_NAMES = new Set(['workspace_arrange_apps', 'screen_capture_summary', 'project_note_update', 'rd_dashboard_task', 'codex_task_file', 'browser_action', 'dashboard_open_card']);

async function handleRndMcpToolCall(name, callId, event) {
  let args = {};
  try { args = JSON.parse(event.arguments || event.output || '{}'); } catch { args = {}; }
  let result;
  try {
    // Browser fallback for older/live sessions must use the same local MCP
    // adapter path as the server sideband. The R&D MCP modes now expose a
    // single Realtime-visible local_mcp_call tool, but existing sessions can
    // still produce direct historical R&D tool calls after a reload/reconnect.
    // Keep those calls semantically equivalent by routing them through the
    // MCP listTools -> callTool validation path too.
    const response = await fetch(apiPath('/rd/local-mcp-call'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ tool: name, arguments: args, sessionToken }),
    });
    result = await response.json().catch(() => ({ ok: false, error: `R&D tool HTTP ${response.status}` }));
  } catch (error) {
    result = { ok: false, error: error.message };
  }
  const output = JSON.stringify(result);
  const spoken = result.result?.spoken || result.result?.summary || result.summary || result.error || result.result?.error || `${name} returned a result.`;
  sendFunctionOutput(callId, output, toolResultAnswerInstructions(result, spoken), { transcript: true, transcriptText: spoken, transcriptData: { source: 'rd_mcp_tool', tool: name, ok: !!result.ok } });
}

async function handleOpenClawToolCall(event) {
  const name = event.name || event.tool_name || event.function?.name;
  const callId = event.call_id || event.callId || event.item_id || event.id;
  if (!callId) return;

  if (name === 'wait_for_user') {
    sendFunctionOutput(callId, 'Waiting silently for the user.');
    return;
  }

  if (name === 'realtime_status') {
    const status = bridgeStatusText();
    sendFunctionOutput(callId, status, exactSpeakInstruction(status), { transcript: true, transcriptData: { source: 'function_output' } });
    return;
  }

  if (name === 'stop_openclaw') {
    await stopOpenClawNow();
    sendFunctionOutput(callId, 'Stopped.', exactSpeakInstruction('Stopped.'), { transcript: true, transcriptData: { source: 'function_output' } });
    return;
  }

  if (name === 'bridge_status') {
    const status = bridgeStatusText();
    sendFunctionOutput(callId, status, exactSpeakInstruction(status), { transcript: true, transcriptData: { source: 'function_output' } });
    return;
  }

  if (name === 'web_search') {
    let args = {};
    try { args = JSON.parse(event.arguments || event.output || '{}'); } catch { args = {}; }
    let result;
    try {
      const response = await fetch(apiPath('/rd/web-search'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ arguments: args, sessionToken }),
      });
      result = await response.json().catch(() => ({ ok: false, error: `web_search HTTP ${response.status}` }));
    } catch (error) {
      result = { ok: false, error: error.message };
    }
    const output = JSON.stringify(result);
    const spoken = result.spoken || result.summary || result.error || 'Web search returned results.';
    sendFunctionOutput(callId, output, toolResultAnswerInstructions(result, spoken), { transcript: true, transcriptText: spoken, transcriptData: { source: 'web_search', ok: !!result.ok } });
    return;
  }

  if (RND_MCP_TOOL_NAMES.has(name)) {
    await handleRndMcpToolCall(name, callId, event);
    return;
  }

  if (name && name !== 'openclaw_turn') return;
  let args = {};
  try { args = JSON.parse(event.arguments || event.output || '{}'); } catch { args = {}; }
  const toolText = String(args.text || '').trim();
  if (!toolText) return;

  const normalized = normalizedToolText(toolText);
  if (normalized && normalized === lastToolCall.text && (Date.now() - lastToolCall.at) < 1800) {
    console.debug('[realtime] suppressed duplicate OpenClaw tool call', toolText);
    sendFunctionOutput(callId, 'Already working on that request.', exactSpeakInstruction('Already working on that request.'), { transcript: true, transcriptData: { source: 'function_output' } });
    return;
  }
  lastToolCall = { text: normalized, at: Date.now() };

  const transcriptText = await waitForRecentUserTranscript(220, lastSpeechStartedAt);
  const text = transcriptText || toolText;
  const task = { callId, text, urgency: args.urgency || 'normal' };
  if (activeToolCall) {
    let steerResult;
    try {
      const response = await fetch(apiPath('/realtime/steer'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text, sessionToken, urgency, processing }),
      });
      steerResult = await response.json().catch(() => ({ ok: false, error: `steer HTTP ${response.status}` }));
    } catch (error) { steerResult = { ok: false, error: error.message }; }
    const steerOutput = JSON.stringify(steerResult);
    const steerSpoken = steerResult.ok ? 'Added that to the active OpenClaw request.' : `OpenClaw steering failed: ${steerResult.error || 'unknown error'}`;
    sendFunctionOutput(callId, steerOutput, exactSpeakInstruction(steerSpoken), { transcript: true, transcriptText: steerSpoken, transcriptData: { source: 'steer_openclaw', ok: !!steerResult.ok } });
    updateStopOpenClawState();
    return;
  }
  await runOpenClawTask(task);
}

async function runOpenClawTask(task) {
  const { callId, text, urgency } = task;
  const turnId = `rt-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  activeToolCall = { callId, turnId, text };
  updateStopOpenClawState();
  setStatus('ASKING OPENCLAW');
  let result;
  try {
    const response = await fetch(apiPath('/realtime/openclaw-turn'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text, sessionToken, turnId, urgency, processing }),
    });
    result = await response.json();
  } catch (error) {
    result = { ok: false, error: error.message };
  }

  if (!activeToolCall || activeToolCall.turnId !== turnId) return;
  activeToolCall = null;
  updateStopOpenClawState();

  if (result.timings) lastOpenClawTimings = result.timings;
  const output = result.ok ? result.reply : (result.cancelled ? 'Stopped.' : `OpenClaw bridge error: ${result.error || 'unknown error'}`);
  sendFunctionOutput(callId, output, exactSpeakInstruction(output), { transcript: true, transcriptData: { turnId, ok: result.ok, source: 'openclaw_output' } });

  if (pendingToolCalls.length) {
    const next = pendingToolCalls.shift();
    updateStopOpenClawState();
    console.debug('[realtime] draining queued OpenClaw request');
    await runOpenClawTask(next);
    return;
  }
  setStatus('connected');
}

function handleRealtimeEvent(raw) {
  let event;
  try { event = JSON.parse(raw); }
  catch { return; }
  try {
    window.__realtimeTestEvents = window.__realtimeTestEvents || [];
    window.__realtimeTestEvents.push({ at: Date.now(), type: event.type || 'event', responseStatus: event.response?.status, transcript: event.transcript || event.text || '', eventId: event.event_id || event.id || '' });
    if (window.__realtimeTestEvents.length > 500) window.__realtimeTestEvents.splice(0, window.__realtimeTestEvents.length - 500);
  } catch {}

  const type = event.type || 'event';
  if (type === 'input_audio_buffer.speech_started') {
    lastSpeechStartedAt = Date.now();
    if (!activeToolCall) setStatus('listening');
    if (muted) return;
    // Avoid canceling OpenClaw work on accidental speakerphone echo. We only stop current Realtime speech.
    sendRealtimeEvent({ type: 'response.cancel' });
    console.debug('[realtime] speech started; preserving active OpenClaw turn');
    return;
  }

  if (type === 'response.function_call_arguments.done') {
    if (sidebandToolOwner) {
      console.debug('[realtime] tool call handled by server sideband; browser fallback suppressed');
      return;
    }
    handleOpenClawToolCall(event).catch((error) => console.error('[realtime] tool call failed', error));
    return;
  }

  if (type === 'conversation.item.input_audio_transcription.completed') {
    const text = event.transcript || event.text || '';
    if (text) rememberUserTranscript(text);
    if (!activeToolCall) setStatus('connected');
    return;
  }

  if (type === 'response.audio_transcript.done') {
    const text = event.transcript || event.text || '';
    if (text && !shouldSuppressAssistantAudioTranscript(text)) saveAssistantTranscript(text, { source: 'audio_transcript' });
  }
}


async function refreshServerBridgeStatus() {
  if (!pc || pc.connectionState === 'closed') return;
  try {
    const response = await fetch(`${apiPath('/realtime/status')}?sessionToken=${encodeURIComponent(sessionToken)}`);
    const status = await response.json();
    if (!status?.ok) return;
    serverBridgeStatus = status;
    if (sidebandToolOwner && status.sideband && !['open', 'connecting'].includes(status.sideband)) {
      sidebandToolOwner = false;
      saveTranscriptEntry('system', 'Server sideband closed; browser fallback is active for tool calls.');
    }
    updateBridgeStateChip();
    updateStopOpenClawState();
  } catch (error) {
    console.debug('[realtime] status refresh failed', error.message);
  }
}

function startStatusPolling() {
  stopStatusPolling();
  statusPollTimer = setInterval(refreshServerBridgeStatus, 1500);
  refreshServerBridgeStatus();
}

function stopStatusPolling() {
  if (statusPollTimer) clearInterval(statusPollTimer);
  statusPollTimer = null;
}

async function connectRealtime() {
  els.connect.disabled = true;
  setConnectLabel('Connecting…');
  setStatus('connecting');
  try {
    const runtimeConfig = await loadConfig();
    pc = new RTCPeerConnection();
    pc.onconnectionstatechange = () => {
      setStatus(pc.connectionState);
      console.debug('[realtime] peer connection', pc.connectionState);
    };
    pc.ontrack = (event) => {
      els.audio.srcObject = event.streams[0];
      els.audio.play().catch((error) => console.warn('[realtime] audio playback blocked', error));
    };
    els.audio.onplay = () => setStatus('speaking');
    els.audio.onended = () => { if (pc && pc.connectionState !== 'closed') setStatus(activeToolCall ? 'ASKING OPENCLAW' : 'connected'); };
    els.audio.onpause = () => { if (pc && pc.connectionState !== 'closed' && !activeToolCall) setStatus('connected'); };

    micStream = await navigator.mediaDevices.getUserMedia({
      audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
      video: false,
    });
    for (const track of micStream.getAudioTracks()) pc.addTrack(track, micStream);
    applyMuteState();

    dc = pc.createDataChannel('oai-events');
    dc.onopen = () => console.debug('[realtime] data channel open');
    dc.onclose = () => console.debug('[realtime] data channel closed');
    dc.onmessage = (event) => handleRealtimeEvent(event.data);

    const offer = await pc.createOffer();
    await pc.setLocalDescription(offer);
    const realtimePath = runtimeConfig.realtimePath || apiPath('/realtime/session');
    const realtimeUrl = routeMode === 'openclaw' ? realtimePath : `${realtimePath}${realtimePath.includes('?') ? '&' : '?'}route=${encodeURIComponent(routeMode)}`;
    const response = await fetch(realtimeUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/sdp',
        'X-Voice-Session-Token': sessionToken,
        'X-OpenClaw-Route': routeMode,
        'X-OpenClaw-Processing': encodeURIComponent(JSON.stringify(processing)),
        'X-Realtime-Reasoning': realtimeSettings.realtimeReasoning,
        'X-Realtime-Turn-Detection': realtimeSettings.turnDetection,
        'X-Realtime-Captions': realtimeSettings.liveCaptions ? '1' : '0',
        'X-Realtime-Transcription-Delay': realtimeSettings.transcriptionDelay,
      },
      body: offer.sdp,
    });
    sidebandToolOwner = response.headers.get('X-OpenClaw-Sideband') === 'started';
    console.debug('[realtime] sideband tool owner=', sidebandToolOwner, { captions: response.headers.get('X-Realtime-Captions'), vad: response.headers.get('X-Realtime-Turn-Detection'), reasoning: response.headers.get('X-Realtime-Reasoning') });
    const answerSdp = await response.text();
    if (!response.ok) throw new Error(answerSdp || `Realtime session failed: ${response.status}`);
    await pc.setRemoteDescription({ type: 'answer', sdp: answerSdp });
    els.disconnect.disabled = false;
    if (els.mute) els.mute.disabled = false;
    updateStopOpenClawState();
    setConnectLabel('Connected');
    els.connect.disabled = true;
    setStatus('connected');
    startStatusPolling();
    updateBridgeStateChip();
    if (isOpenClawRouteMode(routeMode)) schedulePrewarm(50);
  } catch (error) {
    console.warn('[realtime] connection failed', error);
    setStatus('error');
    disconnectRealtime();
  } finally {
    if (!pc || pc.connectionState === 'closed' || pc.connectionState === 'failed') els.connect.disabled = false;
  }
}

function disconnectRealtime() {
  sidebandToolOwner = false;
  stopStatusPolling();
  fetch(apiPath('/realtime/disconnect'), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ sessionToken, reason: 'client disconnect' }),
  }).catch(() => null);
  cancelActiveTurn('disconnect', { force: true }).catch(() => null);
  setConnectLabel('Connect Realtime‑2 intercom');
  if (dc) { try { dc.close(); } catch {} dc = null; }
  if (pc) { try { pc.close(); } catch {} pc = null; }
  if (micStream) {
    for (const track of micStream.getTracks()) track.stop();
    micStream = null;
  }
  els.audio.srcObject = null;
  els.disconnect.disabled = true;
  els.connect.disabled = false;
  if (els.mute) els.mute.disabled = true;
  serverBridgeStatus = { active: false, sideband: 'none' };
  updateBridgeStateChip();
  updateStopOpenClawState();
  setStatus('idle');
}

function newRealtimeSession() {
  disconnectRealtime();
  pendingToolCalls = [];
  lastUserTranscript = { text: '', at: 0 };
  lastToolCall = { text: '', at: 0 };
  lastOpenClawTimings = null;
  lastAssistantTranscript = { text: '', at: 0 };
  serverBridgeStatus = { active: false, sideband: 'none' };
  updateBridgeStateChip();
  updateStopOpenClawState();
  setSessionToken(makeToken());
  localStorage.removeItem(transcriptStorageKey);
  els.log.innerHTML = '<p class="placeholder">Spoken replies and optional captions will appear here.</p>';
}

els.connect.addEventListener('click', connectRealtime);
els.disconnect.addEventListener('click', disconnectRealtime);
els.mute?.addEventListener('click', toggleMute);
els.stopOpenClaw?.addEventListener('click', stopOpenClawNow);
els.newSession?.addEventListener('click', newRealtimeSession);
els.modelSelect?.addEventListener('change', () => { updateProcessingFromInputs(); schedulePrewarm(); });
els.thinkingSelect?.addEventListener('change', () => { updateProcessingFromInputs(); schedulePrewarm(); });
els.realtimeReasoningSelect?.addEventListener('change', updateRealtimeSettingsFromInputs);
els.turnDetectionSelect?.addEventListener('change', updateRealtimeSettingsFromInputs);
els.liveCaptionsToggle?.addEventListener('change', updateRealtimeSettingsFromInputs);
els.routeSelect?.addEventListener('change', updateRouteFromInput);
els.clear.addEventListener('click', () => {
  localStorage.removeItem(transcriptStorageKey);
  els.log.innerHTML = '<p class="placeholder">Spoken replies and optional captions will appear here.</p>';
});
setSessionToken(sessionToken);
applyEmbeddedMode();
restoreTranscript();
updateStopOpenClawState();
syncRouteUi();
updateBridgeStateChip();
setStatus('idle');
loadConfig().catch((error) => console.warn('[realtime] config failed', error));
