const $ = (selector) => document.querySelector(selector);

const els = {
  connectButton: $('#connectButton'),
  disconnectButton: $('#disconnectButton'),
  clearTranscriptButton: $('#clearTranscriptButton'),
  newSessionButton: $('#newSessionButton'),
  settingsToggle: $('#settingsToggle'),
  settingsPanel: $('#settingsPanel'),
  signalUrlInput: $('#signalUrlInput'),
  sessionCodeInput: $('#sessionCodeInput'),
  tokenInput: $('#tokenInput'),
  demoModeInput: $('#demoModeInput'),
  statusLabel: $('#statusLabel'),
  phaseLabel: $('#phaseLabel'),
  transportChip: $('#transportChip'),
  micChip: $('#micChip'),
  interruptChip: $('#interruptChip'),
  sessionChip: $('#sessionChip'),
  wakeChip: $('#wakeChip'),
  wakePhraseChip: $('#wakePhraseChip'),
  handsfreeChip: $('#handsfreeChip'),
  modeHint: $('#modeHint'),
  talkTitle: $('#talkTitle'),
  talkHint: $('#talkHint'),
  halo: $('#halo'),
  transcriptList: $('#transcriptList'),
  localMeter: $('#localMeter'),
  remoteMeter: $('#remoteMeter'),
  remoteAudio: $('#remoteAudio'),
  talkButton: $('#talkButton'),
  interruptButton: $('#interruptButton'),
  pttModeButton: $('#pttModeButton'),
  handsfreeModeButton: $('#handsfreeModeButton'),
  manualWakeButton: $('#manualWakeButton'),
  continuousListenInput: $('#continuousListenInput'),
  processingAgentSelect: $('#processingAgentSelect'),
  processingThinkingSelect: $('#processingThinkingSelect'),
  processingFastModeSelect: $('#processingFastModeSelect'),
  transcriptionEngineSelect: $('#transcriptionEngineSelect'),
  conversationModelSelect: $('#conversationModelSelect'),
  cloudOptionNote: $('#cloudOptionNote'),
  openRealtimeOptionLink: $('#openRealtimeOptionLink'),
  voiceSelect: $('#voiceSelect'),
  ttsSpeedSelect: $('#ttsSpeedSelect'),
  processSoundInput: $('#processSoundInput')
};

const storageKey = 'voice-bridge-client-config-v6';
const transcriptStorageKey = 'voice-bridge-transcript-v1';
const sessionTokenStorageKey = 'voice-bridge-session-token-v1';
const PROCESSING_DEFAULT_VERSION = 'openclaw-tools-gpt55-minimal-2026-05-06';
const VOICE_DEFAULT_VERSION = 'openai-streaming-default-2026-05-07';
const LEGACY_DEFAULT_PROCESSING_AGENTS = new Set(['julian', 'default', 'default-fast', 'intercom', 'gpt54', 'gpt54-fast', 'gpt-5.4', 'chat-latest']);
const LEGACY_DEFAULT_VOICES = new Set(['piper-ryan-high', 'piper-libritts-high']);
const MODES = { PTT: 'ptt', HANDSFREE: 'handsfree' };
const DEFAULT_WAKE_PHRASE = 'Hey';
const HF = {
  OFF: 'off',
  LISTENING: 'listening',
  SUSPENDED: 'suspended',
  COOLDOWN: 'cooldown',
  CAPTURING: 'capturing',
  UNAVAILABLE: 'unavailable'
};

const HANDSFREE_CAPTURE = {
  minBeforeSilenceMs: 900,
  silenceLevel: 18,
  silenceFramesToStop: 8,
  maxCaptureMs: 12000
};

const LISTEN_PROBE = {
  // Wake mode previously waited 2.2s before the first Whisper pass, which made
  // the UI feel slow and lost the start of post-"hey" requests. Shorter probes
  // plus server-side inline wake-turn processing make non-continuous hands-free
  // feel much more immediate without touching continuous listen.
  wakePhraseMs: 1350,
  continuousMs: 950,
  continuousRetryMs: 80,
  wakeRetryMs: 120,
  droppedResponseRetryMs: 160
};

const LOCAL_VAD = {
  checkMs: 80,
  startLevel: 14,
  hotFramesToStart: 3
};

const PRE_ROLL = {
  sliceMs: 150,
  maxChunks: 10
};

const BARGE_IN = {
  checkMs: 80,
  generationStartLevel: 7,
  playbackStartLevel: 12,
  hotFramesToStart: 1,
  generationProbeMs: 1700,
  playbackProbeMs: 1300,
  retryMs: 180
};

const state = {
  socket: null,
  mediaStream: null,
  mediaRecorder: null,
  analyser: null,
  audioContext: null,
  meterTimer: null,
  chunks: [],
  isRecording: false,
  isSpeaking: false,
  currentAudioUrl: null,
  audioUnlocked: false,
  processSoundEnabled: loadProcessSoundConfig(),
  processSoundNodes: null,
  processSoundStopping: false,
  visualStatus: 'Idle',
  visualPhase: 'idle',
  config: loadConfig(),
  reconnectTimer: null,
  reconnectAttempts: 0,
  wasConnected: false,
  interactionMode: loadMode(),
  handsfreeState: HF.OFF,
  wakeRecognition: null,
  wakeProbeRecorder: null,
  wakeProbeChunks: [],
  wakeProbeTimer: null,
  wakeProbeInFlight: false,
  vadTimer: null,
  vadHotFrames: 0,
  preRollRecorder: null,
  preRollChunks: [],
  bargeTimer: null,
  bargeHotFrames: 0,
  bargeRecorder: null,
  bargeChunks: [],
  bargeInFlight: false,
  bargeMode: 'generation',
  continuousListen: loadContinuousListen(),
  wakeAvailable: false,
  wakeArmed: false,
  wakeSuspendReason: '',
  wakeCooldownTimer: null,
  recordStartAt: 0,
  autoStopTimer: null,
  silenceFrames: 0,
  localLevel: 0,
  dropRecordingOnStop: false,
  processing: loadProcessingConfig(),
  cloudOptions: loadCloudOptionsConfig(),
  processingOptions: {
    agents: [
      { id: 'default', label: 'default (julian primary)' },
      { id: 'default-fast', label: 'default-fast (julian primary)' },
      { id: 'opus', label: 'opus (claude-opus-4-6)' },
      { id: 'opus45', label: 'opus45 (claude-opus-4-5)' },
      { id: 'sonnet', label: 'sonnet (claude-sonnet-4-6)' },
      { id: 'sonnet45', label: 'sonnet45 (claude-sonnet-4-5)' },
      { id: 'haiku45', label: 'haiku45 (claude-haiku-4-5)' },
      { id: 'gpt54', label: 'gpt54 (gpt-5.4)' },
      { id: 'gpt53cs', label: 'gpt53cs (gpt-5.3-codex-spark)' },
      { id: 'gpt53c', label: 'gpt53c (gpt-5.3-codex)' },
      { id: 'gpt52', label: 'gpt52 (gpt-5.2)' }
    ],
    thinking: ['off', 'minimal', 'low', 'medium', 'high'],
    fastMode: ['on']
  },
  voice: loadVoiceConfig(),
  ttsSpeed: loadTtsSpeedConfig(),
  sessionToken: loadSessionToken(),
  wakePhrase: DEFAULT_WAKE_PHRASE,
  ttsSpeedOptions: {
    speeds: [
      { id: 'slower', label: 'Slower' },
      { id: 'normal', label: 'Normal' },
      { id: 'faster', label: 'Faster' },
      { id: 'fastest', label: 'Fastest' }
    ],
    defaultSpeed: 'fastest'
  },
  voiceOptions: {
    voices: [
      { id: 'piper-libritts-high', label: 'Piper LibriTTS High' },
      { id: 'piper-ryan-high', label: 'Piper Ryan High' },
      { id: 'say-samantha', label: 'Samantha (macOS)' },
      { id: 'say-flo-en-us', label: 'Flo (English US, macOS)' },
      { id: 'say-eddy-en-us', label: 'Eddy (English US, macOS)' }
    ],
    defaultVoice: 'piper-ryan-high'
  }
};

hydrateInputs();
renderProcessingControls();
renderVoiceControls();
wireEvents();
restoreTranscript();
fetchRuntimeConfig();
applyState({ phase: 'idle', status: 'Idle', detail: 'Ready when you are', transport: initialTransportLabel(), interruptible: undefined });
refreshModeUi();
registerServiceWorker();

// Auto-reconnect when tab regains visibility
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible' && state.wasConnected) {
    const s = state.socket;
    if (!s || s.readyState === WebSocket.CLOSED || s.readyState === WebSocket.CLOSING) {
      clearTimeout(state.reconnectTimer);
      state.reconnectTimer = setTimeout(() => connect(), 800);
    }
  }
});

// Auto-reconnect on focus if socket is dead
window.addEventListener('focus', () => {
  if (state.wasConnected) {
    const s = state.socket;
    if (!s || s.readyState === WebSocket.CLOSED || s.readyState === WebSocket.CLOSING) {
      clearTimeout(state.reconnectTimer);
      state.reconnectTimer = setTimeout(() => connect(), 800);
    }
  }
});

function wireEvents() {
  els.connectButton.addEventListener('click', connect);
  els.disconnectButton.addEventListener('click', () => disconnect('manual disconnect'));
  els.clearTranscriptButton.addEventListener('click', clearTranscript);
  els.newSessionButton?.addEventListener('click', startNewSession);
  els.settingsToggle?.addEventListener('click', () => els.settingsPanel.classList.toggle('hidden'));
  els.interruptButton.addEventListener('click', interruptPlayback);
  els.pttModeButton.addEventListener('click', () => setInteractionMode(MODES.PTT));
  els.handsfreeModeButton.addEventListener('click', () => setInteractionMode(MODES.HANDSFREE));
  els.manualWakeButton.addEventListener('click', () => triggerHandsfreeCapture('manual trigger'));
  els.continuousListenInput?.addEventListener('change', () => setContinuousListen(els.continuousListenInput.checked));
  els.processSoundInput?.addEventListener('change', updateProcessSoundFromInput);

  ['signalUrlInput', 'sessionCodeInput', 'tokenInput', 'demoModeInput'].forEach((key) => {
    els[key].addEventListener('change', persistConfigFromInputs);
  });

  els.processingAgentSelect?.addEventListener('change', updateProcessingFromInputs);
  els.processingThinkingSelect?.addEventListener('change', updateProcessingFromInputs);
  els.processingFastModeSelect?.addEventListener('change', updateProcessingFromInputs);
  els.transcriptionEngineSelect?.addEventListener('change', updateCloudOptionsFromInputs);
  els.conversationModelSelect?.addEventListener('change', updateCloudOptionsFromInputs);
  els.voiceSelect?.addEventListener('change', updateVoiceFromInput);
  els.ttsSpeedSelect?.addEventListener('change', updateTtsSpeedFromInput);

  const start = (event) => {
    event.preventDefault();
    if (state.interactionMode === MODES.PTT) {
      startRecording('ptt');
      return;
    }
    // Hands-free mode: tap-to-toggle fallback/manual capture
    if (state.isRecording) stopRecording('manual');
    else triggerHandsfreeCapture('manual tap');
  };
  const stop = (event) => {
    event.preventDefault();
    if (state.interactionMode === MODES.PTT) stopRecording('ptt');
  };

  ['touchstart', 'mousedown'].forEach((type) => els.talkButton.addEventListener(type, start, { passive: false }));
  ['touchend', 'touchcancel', 'mouseup', 'mouseleave'].forEach((type) => els.talkButton.addEventListener(type, stop, { passive: false }));

  els.remoteAudio.addEventListener('play', () => {
    state.isSpeaking = true;
    els.interruptButton.disabled = false;
    els.interruptButton.classList.add('live');
    setRemoteMeter(90);
    suspendWake('remote speaking');
    applyState({ phase: 'speaking', status: 'Remote live', detail: 'Interrupt if you need the floor', transport: currentTransportLabel(), interruptible: true });
    refreshModeUi();
  });
  els.remoteAudio.addEventListener('ended', finishPlayback);
  els.remoteAudio.addEventListener('pause', () => {
    if (els.remoteAudio.ended) return;
    setRemoteMeter(6);
  });
}

function loadConfig() {
  const saved = JSON.parse(localStorage.getItem(storageKey) || '{}');
  const params = new URLSearchParams(window.location.search);
  return {
    signalUrl: params.get('relay') ?? saved.signalUrl ?? defaultWsUrl(),
    sessionCode: params.get('code') ?? saved.sessionCode ?? '',
    token: params.get('token') ?? saved.token ?? '',
    demoMode: params.get('demo') === '1' || saved.demoMode === true
  };
}

function loadMode() {
  const saved = JSON.parse(localStorage.getItem(storageKey) || '{}');
  return saved.interactionMode === MODES.HANDSFREE ? MODES.HANDSFREE : MODES.PTT;
}

function loadContinuousListen() {
  const saved = JSON.parse(localStorage.getItem(storageKey) || '{}');
  // Hands-free should feel like an intercom by default: no wake phrase required.
  // Users can explicitly turn this off to require “Hey OpenClaw”.
  return saved.continuousListen !== false;
}

function loadProcessSoundConfig() {
  const saved = JSON.parse(localStorage.getItem(storageKey) || '{}');
  // Off by default. Speaker audio can leak into mic/barge-in paths, so ambience
  // must be explicitly enabled and stays gated to safe processing states.
  return saved.processSoundEnabled === true;
}

function loadProcessingConfig() {
  const saved = JSON.parse(localStorage.getItem(storageKey) || '{}');
  let agent = saved.processingAgent || '';
  // Migrate stale saved selections to the current server-selected default.
  // After the user changes the selector, the version is persisted and that
  // explicit choice is honored.
  const isStaleDefault = saved.processingDefaultVersion !== PROCESSING_DEFAULT_VERSION;
  if (isStaleDefault || !agent || LEGACY_DEFAULT_PROCESSING_AGENTS.has(agent)) agent = '';
  return {
    agent,
    thinking: isStaleDefault ? '' : (saved.processingThinking || ''),
    fastMode: 'on'
  };
}

function loadCloudOptionsConfig() {
  const saved = JSON.parse(localStorage.getItem(storageKey) || '{}');
  return {
    transcription: saved.transcriptionEngine === 'gpt-realtime-whisper' ? 'gpt-realtime-whisper' : 'local-whisper',
    model: saved.conversationModel === 'gpt-realtime-2' ? 'gpt-realtime-2' : 'openclaw-gpt55',
  };
}

function loadTtsSpeedConfig() {
  const saved = JSON.parse(localStorage.getItem(storageKey) || '{}');
  return {
    id: saved.ttsSpeed || 'fastest'
  };
}

function loadVoiceConfig() {
  const saved = JSON.parse(localStorage.getItem(storageKey) || '{}');
  const isStaleDefault = saved.voiceDefaultVersion !== VOICE_DEFAULT_VERSION;
  let id = saved.voiceId || '';
  if (isStaleDefault && LEGACY_DEFAULT_VOICES.has(id)) id = ''; // let /config choose OpenAI streaming when available
  return { id };
}

function loadSessionToken() {
  try {
    const existing = sessionStorage.getItem(sessionTokenStorageKey);
    if (existing) return existing;
  } catch {}
  const next = generateSessionToken();
  try { sessionStorage.setItem(sessionTokenStorageKey, next); } catch {}
  return next;
}

function generateSessionToken() {
  if (window.crypto?.randomUUID) return `client-${window.crypto.randomUUID()}`;
  return `client-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

function rotateSessionToken() {
  state.sessionToken = generateSessionToken();
  try { sessionStorage.setItem(sessionTokenStorageKey, state.sessionToken); } catch {}
  return state.sessionToken;
}

function hydrateInputs() {
  els.signalUrlInput.value = state.config.signalUrl;
  els.sessionCodeInput.value = state.config.sessionCode;
  els.tokenInput.value = state.config.token;
  els.demoModeInput.checked = !!state.config.demoMode;
  if (els.processingAgentSelect) els.processingAgentSelect.value = state.processing.agent;
  if (els.processingThinkingSelect) els.processingThinkingSelect.value = state.processing.thinking;
  if (els.processingFastModeSelect) els.processingFastModeSelect.value = state.processing.fastMode;
  if (els.transcriptionEngineSelect) els.transcriptionEngineSelect.value = state.cloudOptions.transcription;
  if (els.conversationModelSelect) els.conversationModelSelect.value = state.cloudOptions.model;
  if (els.voiceSelect) els.voiceSelect.value = state.voice.id;
  if (els.ttsSpeedSelect) els.ttsSpeedSelect.value = state.ttsSpeed.id;
  if (els.continuousListenInput) els.continuousListenInput.checked = state.continuousListen;
  if (els.processSoundInput) els.processSoundInput.checked = state.processSoundEnabled;
}

function persistConfigFromInputs() {
  state.config = {
    signalUrl: els.signalUrlInput.value.trim() || defaultWsUrl(),
    sessionCode: els.sessionCodeInput.value.trim(),
    token: els.tokenInput.value.trim(),
    demoMode: els.demoModeInput.checked
  };
  localStorage.setItem(storageKey, JSON.stringify({
    ...state.config,
    interactionMode: state.interactionMode,
    processingAgent: state.processing.agent,
    processingThinking: state.processing.thinking,
    processingFastMode: state.processing.fastMode,
    processingDefaultVersion: PROCESSING_DEFAULT_VERSION,
    transcriptionEngine: state.cloudOptions.transcription,
    conversationModel: state.cloudOptions.model,
    continuousListen: state.continuousListen,
    processSoundEnabled: state.processSoundEnabled,
    voiceId: state.voice.id,
    voiceDefaultVersion: VOICE_DEFAULT_VERSION,
    ttsSpeed: state.ttsSpeed.id,
  }));
}

async function fetchRuntimeConfig() {
  try {
    const response = await fetch('./config', { cache: 'no-store' });
    if (!response.ok) return;
    const payload = await response.json();
    const processing = payload?.processing;
    if (processing?.agents?.length) {
      state.processingOptions = {
        agents: processing.agents,
        thinking: processing.thinking || state.processingOptions.thinking,
        defaultThinking: processing.defaultThinking || 'minimal',
        fastMode: ['on'],
      };
      if (processing.defaultAgent && !state.processing.agent) state.processing.agent = processing.defaultAgent;
      if (processing.defaultThinking && !state.processing.thinking) state.processing.thinking = processing.defaultThinking;
      renderProcessingControls();
      updateProcessingFromInputs(true);
    }

    if (payload?.wsPath) {
      const runtimeWs = wsUrlFromRuntimePath(payload.wsPath);
      const current = state.config.signalUrl || '';
      const stalePageDerived = /\/[^/]+\.html\/ws$/.test(current);
      const sameOrigin = (() => { try { return new URL(current).host === window.location.host; } catch { return false; } })();
      if (!current || stalePageDerived || (sameOrigin && current !== runtimeWs)) {
        state.config.signalUrl = runtimeWs;
        if (els.signalUrlInput) els.signalUrlInput.value = runtimeWs;
        persistConfigFromInputs();
      }
    }

    if (payload?.wakePhrase) state.wakePhrase = payload.wakePhrase;
    if (payload?.realtime) syncCloudOptionsUi(payload.realtime);
    refreshModeUi();

    const tts = payload?.tts;
    if (tts?.voices?.length) {
      state.voiceOptions = {
        voices: tts.voices,
        defaultVoice: tts.defaultVoice || state.voiceOptions.defaultVoice,
      };
      if (tts.speeds?.length) {
        state.ttsSpeedOptions = {
          speeds: tts.speeds,
          defaultSpeed: tts.defaultSpeed || state.ttsSpeedOptions.defaultSpeed,
        };
      }
      renderVoiceControls();
      renderTtsSpeedControls();
      updateVoiceFromInput(true);
      updateTtsSpeedFromInput(true);
    }
  } catch {
    // Keep local defaults if runtime config endpoint is unavailable.
  }
}

function syncCloudOptionsUi(realtime = state.runtimeRealtime || {}) {
  state.runtimeRealtime = realtime || state.runtimeRealtime || {};
  if (els.cloudOptionNote) {
    els.cloudOptionNote.textContent = 'Realtime‑2 Command Voice is the primary high-capability intercom: speech-to-speech Realtime‑2, OpenClaw sideband tools, optional captions, and explicit turn detection. Open it from this card; classic push-to-talk stays here.';
  }
}

function updateCloudOptionsFromInputs() {
  if (els.transcriptionEngineSelect) state.cloudOptions.transcription = els.transcriptionEngineSelect.value || state.cloudOptions.transcription;
  if (els.conversationModelSelect) state.cloudOptions.model = els.conversationModelSelect.value || state.cloudOptions.model;
  persistConfigFromInputs();
  syncCloudOptionsUi();
  const wantsRealtime = state.cloudOptions.transcription === 'gpt-realtime-whisper' || state.cloudOptions.model === 'gpt-realtime-2';
  addTranscript('system', wantsRealtime
    ? 'Realtime cloud option selected. Tap Open Realtime‑2 to use GPT‑Realtime‑2 / GPT‑Realtime‑Whisper.'
    : 'Local/private option selected: whisper.cpp + OpenClaw tools.');
}


function prettyModelLabel(value = '') {
  const text = String(value || '');
  if (/chat-latest/i.test(text)) return 'GPT-5.5 Instant (chat-latest)';
  const raw = text.replace(/^openai-codex\//, '').replace(/^openai\//, '').replace(/^gpt-/, 'GPT ');
  return raw.split('-').map((part) => {
    if (/^gpt$/i.test(part)) return 'GPT';
    if (/^\d+(?:\.\d+)?$/.test(part)) return part;
    return part.charAt(0).toUpperCase() + part.slice(1);
  }).join(' ').replace(/^GPT\s+/, 'GPT ');
}

function prettyLabel(value = '') {
  const text = String(value || '');
  return text.charAt(0).toUpperCase() + text.slice(1);
}

function renderProcessingControls() {
  if (!els.processingAgentSelect || !els.processingThinkingSelect) return;

  const agents = state.processingOptions.agents || [];
  const thinkingLevels = state.processingOptions.thinking || ['off', 'minimal', 'low', 'medium', 'high'];
  const fastModes = ['on'];

  els.processingAgentSelect.innerHTML = '';
  agents.forEach((agent) => {
    const option = document.createElement('option');
    option.value = agent.id;
    option.textContent = prettyModelLabel(agent.label || agent.id);
    els.processingAgentSelect.appendChild(option);
  });

  els.processingThinkingSelect.innerHTML = '';
  thinkingLevels.forEach((level) => {
    const option = document.createElement('option');
    option.value = level;
    option.textContent = prettyLabel(level);
    els.processingThinkingSelect.appendChild(option);
  });

  if (!agents.some((agent) => agent.id === state.processing.agent) && agents[0]) {
    state.processing.agent = agents[0].id;
  }
  if (!thinkingLevels.includes(state.processing.thinking)) {
    state.processing.thinking = thinkingLevels.includes(state.processingOptions.defaultThinking)
      ? state.processingOptions.defaultThinking
      : (thinkingLevels.includes('minimal') ? 'minimal' : thinkingLevels[0]);
  }

  state.processing.fastMode = 'on';

  els.processingAgentSelect.value = state.processing.agent;
  els.processingThinkingSelect.value = state.processing.thinking;
  if (els.processingFastModeSelect) els.processingFastModeSelect.value = 'on';
}

function updateProcessingFromInputs(silent = false) {
  if (els.processingAgentSelect) state.processing.agent = els.processingAgentSelect.value || state.processing.agent;
  if (els.processingThinkingSelect) state.processing.thinking = els.processingThinkingSelect.value || state.processing.thinking;
  state.processing.fastMode = 'on';
  persistConfigFromInputs();

  if (!silent && state.socket?.readyState === WebSocket.OPEN) {
    sendJson({ type: 'config_update', processing: state.processing, voice: state.voice.id, ttsSpeed: state.ttsSpeed.id, sessionToken: state.sessionToken });
    addTranscript('system', `Processing set: ${prettyModelLabel(state.processing.agent)} · ${prettyLabel(state.processing.thinking)} reasoning · Fast Mode ON`);
  }
}

function renderVoiceControls() {
  if (!els.voiceSelect) return;

  const voices = state.voiceOptions.voices || [];
  els.voiceSelect.innerHTML = '';

  voices.forEach((voice) => {
    const option = document.createElement('option');
    option.value = voice.id;
    option.textContent = voice.label || voice.id;
    els.voiceSelect.appendChild(option);
  });

  if (!voices.some((voice) => voice.id === state.voice.id)) {
    state.voice.id = state.voiceOptions.defaultVoice || voices[0]?.id || state.voice.id;
  }

  if (state.voice.id) {
    els.voiceSelect.value = state.voice.id;
  }
}

function renderTtsSpeedControls() {
  if (!els.ttsSpeedSelect) return;
  const speeds = state.ttsSpeedOptions.speeds || [];
  els.ttsSpeedSelect.innerHTML = '';
  speeds.forEach((speed) => {
    const option = document.createElement('option');
    option.value = speed.id;
    option.textContent = speed.label || speed.id;
    els.ttsSpeedSelect.appendChild(option);
  });
  if (!speeds.some((speed) => speed.id === state.ttsSpeed.id)) {
    state.ttsSpeed.id = state.ttsSpeedOptions.defaultSpeed || speeds[0]?.id || state.ttsSpeed.id;
  }
  if (state.ttsSpeed.id) els.ttsSpeedSelect.value = state.ttsSpeed.id;
}

function updateTtsSpeedFromInput(silent = false) {
  if (els.ttsSpeedSelect) state.ttsSpeed.id = els.ttsSpeedSelect.value || state.ttsSpeed.id;
  persistConfigFromInputs();

  if (!silent && state.socket?.readyState === WebSocket.OPEN) {
    sendJson({ type: 'config_update', processing: state.processing, voice: state.voice.id, ttsSpeed: state.ttsSpeed.id, sessionToken: state.sessionToken });
    const selected = state.ttsSpeedOptions.speeds.find((v) => v.id === state.ttsSpeed.id);
    addTranscript('system', `Speech speed set: ${selected?.label || state.ttsSpeed.id}`);
  }
}

function updateProcessSoundFromInput() {
  state.processSoundEnabled = !!els.processSoundInput?.checked;
  persistConfigFromInputs();
  syncProcessSound();
  addTranscript('system', state.processSoundEnabled
    ? 'Safe process sound enabled. It only plays in push-to-talk processing, never during hands-free/realtime listening.'
    : 'Safe process sound disabled.');
}

function updateVoiceFromInput(silent = false) {
  if (els.voiceSelect) state.voice.id = els.voiceSelect.value || state.voice.id;
  persistConfigFromInputs();

  if (!silent && state.socket?.readyState === WebSocket.OPEN) {
    sendJson({ type: 'config_update', processing: state.processing, voice: state.voice.id, ttsSpeed: state.ttsSpeed.id, sessionToken: state.sessionToken });
    const selected = state.voiceOptions.voices.find((v) => v.id === state.voice.id);
    addTranscript('system', `Voice set: ${selected?.label || state.voice.id}`);
  }
}

function defaultWsUrl() {
  const proto = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
  const path = window.location.pathname || '/';
  const withoutFile = /\.[a-z0-9]+$/i.test(path) ? path.slice(0, path.lastIndexOf('/')) : path.replace(/\/$/, '');
  const basePath = withoutFile === '/' ? '' : withoutFile;
  return `${proto}//${window.location.host}${basePath}/ws`;
}

function wsUrlFromRuntimePath(wsPath = '/ws') {
  const proto = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
  const path = String(wsPath || '/ws').startsWith('/') ? wsPath : `/${wsPath}`;
  return `${proto}//${window.location.host}${path}`;
}

function socketIsOpen() {
  return state.socket?.readyState === WebSocket.OPEN;
}

function initialTransportLabel() {
  return state.config.demoMode ? 'preview mode' : 'offline';
}

function shortSessionToken() {
  const token = String(state.sessionToken || 'pending');
  if (token.length <= 12) return token;
  return `${token.slice(0, 8)}…${token.slice(-4)}`;
}

function currentTransportLabel() {
  if (state.config.demoMode) return 'preview mode';
  return state.socket?.readyState === WebSocket.OPEN ? 'online' : 'offline';
}

function scheduleReconnect(detail = 'Connection lost; retrying…') {
  if (!state.wasConnected || state.config.demoMode) return;
  clearTimeout(state.reconnectTimer);
  const delay = Math.min(5000, 700 + (state.reconnectAttempts++ * 500));
  applyState({ phase: 'connecting', status: 'Reconnecting', detail, transport: 'offline', interruptible: false });
  state.reconnectTimer = setTimeout(() => {
    connect().catch((error) => {
      console.error(error);
      scheduleReconnect(error.message || 'Reconnect failed; retrying…');
    });
  }, delay);
}

function shouldProcessSoundPlay() {
  if (!state.processSoundEnabled) return false;
  if (state.config.demoMode || state.isRecording || state.isSpeaking) return false;
  // Keep speaker-generated ambience out of all hands-free mic loops. The visual
  // pulse carries those modes; sound is safest in explicit PTT only.
  if (state.interactionMode === MODES.HANDSFREE) return false;
  const visual = String(state.visualPhase || '').toLowerCase();
  return visual === 'transcribing' || visual === 'processing';
}

function syncProcessSound() {
  if (shouldProcessSoundPlay()) startProcessSound();
  else stopProcessSound();
}

function startProcessSound() {
  if (state.processSoundNodes || state.processSoundStopping) return;
  const AudioContextCtor = window.AudioContext || window.webkitAudioContext;
  if (!AudioContextCtor) return;
  const ctx = state.audioContext || new AudioContextCtor();
  state.audioContext = ctx;
  if (ctx.state === 'suspended') ctx.resume().catch(() => null);

  const master = ctx.createGain();
  master.gain.value = 0.0001;
  const filter = ctx.createBiquadFilter();
  filter.type = 'bandpass';
  filter.frequency.value = 740;
  filter.Q.value = 0.8;

  const carrier = ctx.createOscillator();
  carrier.type = 'sine';
  carrier.frequency.value = 164;
  const shimmer = ctx.createOscillator();
  shimmer.type = 'triangle';
  shimmer.frequency.value = 247;
  const lfo = ctx.createOscillator();
  lfo.type = 'sine';
  lfo.frequency.value = 0.42;
  const lfoGain = ctx.createGain();
  lfoGain.gain.value = 0.010;

  lfo.connect(lfoGain).connect(master.gain);
  carrier.connect(filter);
  shimmer.connect(filter);
  filter.connect(master).connect(ctx.destination);

  const now = ctx.currentTime;
  master.gain.cancelScheduledValues(now);
  master.gain.setValueAtTime(0.0001, now);
  // Very low by design: texture, not a speakerphone siren. Users can turn it
  // off, and it is gated away from active recording/continuous listen.
  master.gain.exponentialRampToValueAtTime(0.018, now + 0.25);
  carrier.start(now);
  shimmer.start(now);
  lfo.start(now);
  state.processSoundNodes = { ctx, master, filter, carrier, shimmer, lfo };
}

function stopProcessSound() {
  const nodes = state.processSoundNodes;
  if (!nodes || state.processSoundStopping) return;
  state.processSoundStopping = true;
  state.processSoundNodes = null;
  const { ctx, master, carrier, shimmer, lfo } = nodes;
  const now = ctx.currentTime;
  try {
    master.gain.cancelScheduledValues(now);
    master.gain.setValueAtTime(Math.max(master.gain.value || 0.0001, 0.0001), now);
    master.gain.exponentialRampToValueAtTime(0.0001, now + 0.16);
  } catch {}
  setTimeout(() => {
    for (const node of [carrier, shimmer, lfo]) {
      try { node.stop(); } catch {}
      try { node.disconnect(); } catch {}
    }
    try { master.disconnect(); } catch {}
    state.processSoundStopping = false;
  }, 220);
}


async function connect() {
  persistConfigFromInputs();
  if (state.config.demoMode) {
    applyState({ phase: 'connected', status: 'Preview', detail: 'No network; UI only', transport: 'preview mode', interruptible: true });
    els.connectButton.disabled = true;
    els.disconnectButton.disabled = false;
    els.talkButton.disabled = false;
    els.micChip.textContent = 'demo mic';
    addTranscript('system', 'Preview mode enabled. Disable it to use the live bridge.');
    if (state.interactionMode === MODES.HANDSFREE) startWakeEngine();
    refreshModeUi();
    return;
  }

  if (state.socket && (state.socket.readyState === WebSocket.OPEN || state.socket.readyState === WebSocket.CONNECTING)) return;

  applyState({ phase: 'connecting', status: 'Linking', detail: 'Opening secure relay', transport: 'offline', interruptible: false });
  els.connectButton.disabled = true;

  try {
    await ensureMic();
    await unlockPlayback();
    await openSocket();
    if (state.interactionMode === MODES.HANDSFREE) startWakeEngine();
    refreshModeUi();
  } catch (error) {
    console.error(error);
    if (state.wasConnected) {
      els.connectButton.disabled = false;
      els.disconnectButton.disabled = true;
      stopWakeEngine();
      scheduleReconnect(error.message || 'Reconnect failed; retrying…');
      return;
    }
    applyState({ phase: 'error', status: 'Blocked', detail: error.message || 'Connection failed', transport: 'offline', interruptible: false });
    els.connectButton.disabled = false;
    els.disconnectButton.disabled = true;
    stopWakeEngine();
  }
}

function openSocket() {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(state.config.signalUrl);
    ws.binaryType = 'arraybuffer';
    state.socket = ws;
    let settled = false;

    ws.addEventListener('open', () => {
      settled = true;
      state.wasConnected = true;
      state.reconnectAttempts = 0;
      sendJson({
        type: 'start_session',
        sessionCode: state.config.sessionCode || undefined,
        token: state.config.token || undefined,
        processing: state.processing,
        voice: state.voice.id,
        ttsSpeed: state.ttsSpeed.id,
        sessionToken: state.sessionToken,
      });
      els.disconnectButton.disabled = false;
      els.talkButton.disabled = false;
      resolve();
    });

    ws.addEventListener('message', async (event) => {
      if (typeof event.data === 'string') {
        handleMessage(JSON.parse(event.data));
      } else {
        await handleAudioFrame(event.data);
      }
    });

    ws.addEventListener('close', () => {
      state.socket = null;
      stopWakeEngine();
      stopBargeInLoop();
      els.connectButton.disabled = false;
      els.disconnectButton.disabled = true;
      els.talkButton.disabled = true;
      if (!settled) {
        reject(new Error('Relay refused connection'));
      } else {
        scheduleReconnect('Connection closed; restoring listener…');
      }
      refreshModeUi();
    });

    ws.addEventListener('error', () => {
      if (!settled) reject(new Error('Relay connection failed'));
    });
  });
}

function getUserMediaCompat(constraints) {
  const mediaDevices = navigator.mediaDevices;
  if (window.isSecureContext === false) {
    throw new Error('Microphone access requires HTTPS or localhost in this browser.');
  }

  if (mediaDevices?.getUserMedia) {
    return mediaDevices.getUserMedia.call(mediaDevices, constraints);
  }

  const legacyGetUserMedia = navigator.getUserMedia
    || navigator.webkitGetUserMedia
    || navigator.mozGetUserMedia
    || navigator.msGetUserMedia;

  if (legacyGetUserMedia) {
    return new Promise((resolve, reject) => legacyGetUserMedia.call(navigator, constraints, resolve, reject));
  }

  const secureHint = window.isSecureContext === false
    ? ' Microphone access requires HTTPS (or localhost) in this browser.'
    : '';
  throw new Error(`Microphone capture is unavailable in this browser.${secureHint}`);
}

async function ensureMic() {
  if (state.mediaStream) return;
  let stream;
  try {
    stream = await getUserMediaCompat({
      audio: {
      echoCancellation: true,
      noiseSuppression: true,
      autoGainControl: true,
        channelCount: 1
      },
      video: false
    });
  } catch (error) {
    els.micChip.textContent = 'mic unavailable';
    throw error;
  }
  state.mediaStream = stream;
  els.micChip.textContent = 'mic live';

  const AudioContextCtor = window.AudioContext || window.webkitAudioContext;
  if (!AudioContextCtor) {
    startMeterLoop();
    return;
  }

  state.audioContext = state.audioContext || new AudioContextCtor();
  if (state.audioContext.state === 'suspended') {
    try { await state.audioContext.resume(); } catch {}
  }
  const source = state.audioContext.createMediaStreamSource(stream);
  state.analyser = state.audioContext.createAnalyser();
  state.analyser.fftSize = 256;
  source.connect(state.analyser);
  startMeterLoop();
}

function startMeterLoop() {
  if (state.meterTimer || !state.analyser) return;
  const freqData = new Uint8Array(state.analyser.frequencyBinCount);
  const timeData = new Uint8Array(state.analyser.fftSize);
  state.meterTimer = window.setInterval(() => {
    state.analyser.getByteFrequencyData(freqData);
    state.analyser.getByteTimeDomainData(timeData);
    const freqAvg = freqData.reduce((sum, value) => sum + value, 0) / freqData.length;
    let sumSquares = 0;
    for (const value of timeData) {
      const centered = value - 128;
      sumSquares += centered * centered;
    }
    const rms = Math.sqrt(sumSquares / timeData.length);
    const level = Math.max(freqAvg, rms * 4);
    state.localLevel = level;
    const width = Math.max(4, Math.min(100, level * 3));
    els.localMeter.style.width = `${width}%`;
    if (state.interactionMode === MODES.HANDSFREE && state.isRecording) maybeAutoStopHandsfree();
  }, 80);
}

function pickMimeType() {
  const candidates = ['audio/webm;codecs=opus', 'audio/mp4', 'audio/webm', 'audio/ogg;codecs=opus'];
  return candidates.find((value) => window.MediaRecorder && MediaRecorder.isTypeSupported?.(value)) || '';
}

function startRecording(origin = 'ptt', initialChunks = []) {
  if (state.config.demoMode) {
    addTranscript('local', 'Preview mode does not capture live audio.');
    applyState({ phase: 'connected', status: 'Preview', detail: 'No network; UI only', transport: 'preview mode', interruptible: true });
    return;
  }
  if (!state.socket || state.socket.readyState !== WebSocket.OPEN || state.isRecording || !state.mediaStream) return;

  interruptPlayback(true);
  suspendWake(origin === 'wakeword' ? 'capturing voice command' : 'recording');
  state.chunks = Array.isArray(initialChunks) ? [...initialChunks] : [];
  state.silenceFrames = 0;
  state.recordStartAt = Date.now();

  const mimeType = pickMimeType();
  state.mediaRecorder = mimeType ? new MediaRecorder(state.mediaStream, { mimeType }) : new MediaRecorder(state.mediaStream);

  state.mediaRecorder.addEventListener('dataavailable', (event) => {
    if (event.data && event.data.size > 0) state.chunks.push(event.data);
  });
  state.mediaRecorder.addEventListener('stop', async () => {
    const discard = state.dropRecordingOnStop;
    state.dropRecordingOnStop = false;
    const blob = new Blob(state.chunks, { type: state.mediaRecorder.mimeType || 'application/octet-stream' });
    const buffer = await blob.arrayBuffer();
    if (!discard && state.socket?.readyState === WebSocket.OPEN && buffer.byteLength > 0) {
      state.socket.send(buffer);
      sendJson({ type: 'audio_end' });
      applyState({ phase: 'connecting', status: 'Sending', detail: 'Uploading your turn', transport: currentTransportLabel(), interruptible: false });
    }
    state.chunks = [];
    queueWakeCooldown(1000);
    refreshModeUi();
  }, { once: true });

  state.mediaRecorder.start();
  state.isRecording = true;
  els.talkButton.classList.add('active');
  applyState({ phase: 'connected', status: 'Listening', detail: origin === 'ptt' ? 'Release to transmit' : 'Speak now', transport: currentTransportLabel(), interruptible: false, localSpeaking: true });
  refreshModeUi();

  if (state.interactionMode === MODES.HANDSFREE) {
    clearTimeout(state.autoStopTimer);
    state.autoStopTimer = setTimeout(() => stopRecording('max-len'), HANDSFREE_CAPTURE.maxCaptureMs);
  }
}

function stopRecording(reason = 'manual') {
  if (!state.isRecording || !state.mediaRecorder) return;
  state.isRecording = false;
  els.talkButton.classList.remove('active');
  clearTimeout(state.autoStopTimer);
  state.autoStopTimer = null;
  if (state.mediaRecorder.state !== 'inactive') {
    state.mediaRecorder.stop();
  }
  if (reason === 'silence') {
    addTranscript('system', 'Hands-free: command ended (silence detected).');
  }
}

function maybeAutoStopHandsfree() {
  const elapsed = Date.now() - state.recordStartAt;
  if (elapsed < HANDSFREE_CAPTURE.minBeforeSilenceMs) return;
  if (state.localLevel < HANDSFREE_CAPTURE.silenceLevel) state.silenceFrames += 1;
  else state.silenceFrames = 0;
  if (state.silenceFrames >= HANDSFREE_CAPTURE.silenceFramesToStop) stopRecording('silence');
}

function startNewSession() {
  const nextToken = rotateSessionToken();
  if (state.isRecording) state.dropRecordingOnStop = true;
  stopRecording('new-session');
  interruptPlayback(true);
  clearTranscript();
  addTranscript('system', 'Started new session.');

  if (state.config.demoMode) {
    applyState({ phase: 'connected', status: 'Preview', detail: 'Started a fresh preview session', transport: 'preview mode', interruptible: true });
    refreshModeUi();
    return;
  }

  if (state.socket?.readyState === WebSocket.OPEN) {
    sendJson({
      type: 'start_session',
      sessionCode: state.config.sessionCode || undefined,
      token: state.config.token || undefined,
      processing: state.processing,
      voice: state.voice.id,
      ttsSpeed: state.ttsSpeed.id,
      sessionToken: nextToken,
    });
    applyState({ phase: 'connecting', status: 'Resetting', detail: 'Starting a fresh backend session', transport: currentTransportLabel(), interruptible: false });
    refreshModeUi();
    return;
  }

  if (state.wasConnected) {
    connect();
    return;
  }

  applyState({ phase: 'idle', status: 'Offline', detail: 'Fresh session queued for next connect', transport: 'offline', interruptible: false });
  refreshModeUi();
}

function disconnect(reason = 'disconnect') {
  if (state.isRecording) state.dropRecordingOnStop = true;
  stopRecording('disconnect');
  interruptPlayback(true);
  state.wasConnected = false;
  clearTimeout(state.reconnectTimer);
  stopWakeEngine();
  stopBargeInLoop();
  state.socket?.close();
  state.socket = null;
  applyState({ phase: 'idle', status: 'Offline', detail: reason, transport: 'offline', interruptible: false });
  els.connectButton.disabled = false;
  els.disconnectButton.disabled = true;
  els.talkButton.disabled = true;
  refreshModeUi();
}

function sendJson(payload) {
  if (state.socket && state.socket.readyState === WebSocket.OPEN) {
    state.socket.send(JSON.stringify(payload));
  }
}

function handleMessage(message) {
  switch (message.type) {
    case 'status':
      if (message.status === 'ready') {
        stopBargeInLoop();
        if (state.interactionMode === MODES.HANDSFREE) startWakeEngine();
        applyState({ phase: 'connected', status: 'Stand by', detail: state.interactionMode === MODES.PTT ? 'Hold to send' : `Say “${state.wakePhrase}”`, transport: currentTransportLabel(), interruptible: true });
        addTranscript('system', state.interactionMode === MODES.PTT ? `Link secure. Session ${shortSessionToken()}. Hold to send.` : `Link secure. Session ${shortSessionToken()}. Hands-free armed. Say “${state.wakePhrase}”.`);
      }
      if (message.status === 'transcribing') {
        suspendWake('transcribing');
        applyState({ phase: 'connecting', status: 'Transcribing', detail: 'Local speech-to-text pass', transport: currentTransportLabel(), interruptible: false });
      }
      if (message.status === 'thinking') {
        suspendWake('thinking');
        startBargeInLoop('generation');
        applyState({ phase: 'connecting', status: 'Thinking', detail: 'Generating response — say “wait” or “hold on” to cancel', transport: currentTransportLabel(), interruptible: true });
      }
      refreshModeUi();
      break;
    case 'transcript':
      addTranscript('local', message.text || '');
      break;
    case 'reply':
      addTranscript('remote', message.text || '');
      break;
    case 'tts_start':
      suspendWake('tts playback');
      startBargeInLoop('playback');
      applyState({ phase: 'speaking', status: 'Remote live', detail: 'Say “wait” or “hold on” to interrupt', transport: currentTransportLabel(), interruptible: true, remoteSpeaking: true });
      els.interruptButton.disabled = false;
      els.interruptButton.classList.add('live');
      els.interruptButton.classList.remove('armed');
      refreshModeUi();
      break;
    case 'tts_end':
      finishPlayback();
      break;
    case 'interrupted':
      stopBargeInLoop();
      finishPlayback();
      addTranscript('system', message.reason === 'voice-barge-in' ? `Voice interrupt: ${message.text || 'cancelled'}` : 'Playback interrupted.');
      if (message.remainder) addTranscript('local', message.remainder);
      break;
    case 'barge_remainder_started':
      addTranscript('local', message.text || '');
      applyState({ phase: 'connecting', status: 'Thinking', detail: 'Processing the rest of what you said', transport: currentTransportLabel(), interruptible: true });
      break;
    case 'queued_turn_started':
      addTranscript('system', `Processing queued turn${message.remaining ? ` (${message.remaining} still waiting)` : ''}.`);
      applyState({ phase: 'connecting', status: 'Thinking', detail: 'Processing queued follow-up', transport: currentTransportLabel(), interruptible: true });
      break;
    case 'barge_probe_result':
      state.bargeInFlight = false;
      if (!message.matched) scheduleBargeProbe(BARGE_IN.retryMs);
      break;
    case 'wake_probe_result':
      state.wakeProbeInFlight = false;
      if (message.matched && !state.continuousListen) addTranscript('system', `Wake probe matched: ${message.text || 'wake phrase'}`);
      if (state.wakeArmed && !message.matched) scheduleNextWakeProbe(state.continuousListen ? LISTEN_PROBE.continuousRetryMs : LISTEN_PROBE.wakeRetryMs);
      break;
    case 'wake_detected':
      state.wakeProbeInFlight = false;
      triggerHandsfreeCapture('wake word');
      break;
    case 'wake_turn_started':
      state.wakeProbeInFlight = false;
      suspendWake('processing wake turn');
      applyState({ phase: 'connecting', status: 'Thinking', detail: 'Processing what you said after the wake word', transport: currentTransportLabel(), interruptible: true });
      break;
    case 'continuous_turn_started':
      state.wakeProbeInFlight = false;
      suspendWake('processing voice');
      addTranscript('local', message.text || '');
      applyState({ phase: 'connecting', status: 'Thinking', detail: 'Processing what you just said', transport: currentTransportLabel(), interruptible: true });
      break;
    case 'processing':
      if (message.processing?.agent) state.processing.agent = message.processing.agent;
      if (message.processing?.thinking) state.processing.thinking = message.processing.thinking;
      if (message.processing?.sessionToken) {
        state.sessionToken = message.processing.sessionToken;
        try { sessionStorage.setItem(sessionTokenStorageKey, state.sessionToken); } catch {}
      }
      renderProcessingControls();
      persistConfigFromInputs();
      break;
    case 'voice':
      if (message.voice?.id) {
        state.voice.id = message.voice.id;
        if (els.voiceSelect) els.voiceSelect.value = state.voice.id;
        persistConfigFromInputs();
      }
      if (message.voice?.fallbackUsed) {
        addTranscript('system', `Requested voice unavailable; using ${message.voice.label || message.voice.id}.`);
      }
      break;
    case 'busy':
      applyState({ phase: 'connecting', status: 'Thinking', detail: message.message || 'OpenClaw is still processing', transport: currentTransportLabel(), interruptible: true });
      addTranscript('system', message.message || 'OpenClaw is still processing the previous turn.');
      refreshModeUi();
      break;
    case 'error':
      queueWakeCooldown(800);
      applyState({ phase: 'error', status: 'Error', detail: message.message || 'Unknown error', transport: currentTransportLabel(), interruptible: false });
      addTranscript('system', `Error: ${message.message || 'unknown error'}`);
      refreshModeUi();
      break;
    default:
      console.debug('Unhandled message', message);
  }
}


async function unlockPlayback() {
  if (state.audioUnlocked || !els.remoteAudio) return;
  try {
    els.remoteAudio.muted = true;
    const silentWav = 'data:audio/wav;base64,UklGRiQAAABXQVZFZm10IBAAAAABAAEAESsAACJWAAACABAAZGF0YQAAAAA=';
    els.remoteAudio.src = silentWav;
    await els.remoteAudio.play();
    els.remoteAudio.pause();
    els.remoteAudio.currentTime = 0;
    els.remoteAudio.muted = false;
    els.remoteAudio.removeAttribute('src');
    state.audioUnlocked = true;
  } catch (error) {
    els.remoteAudio.muted = false;
    addTranscript('system', `Audio unlock blocked: ${error.message}. Tap once after connecting if playback is silent.`);
  }
}

async function handleAudioFrame(arrayBuffer) {
  revokeCurrentAudioUrl();
  const blob = new Blob([arrayBuffer], { type: 'audio/wav' });
  state.currentAudioUrl = URL.createObjectURL(blob);
  els.remoteAudio.src = state.currentAudioUrl;
  try {
    await els.remoteAudio.play();
  } catch (error) {
    addTranscript('system', `Audio playback blocked: ${error.message}`);
  }
}

function interruptPlayback(silent = false) {
  stopBargeInLoop();
  if (!silent) sendJson({ type: 'interrupt' });
  els.remoteAudio.pause();
  els.remoteAudio.currentTime = 0;
  revokeCurrentAudioUrl();
  state.isSpeaking = false;
  els.interruptButton.disabled = true;
  els.interruptButton.classList.remove('live', 'armed');
  applyState({ phase: 'connecting', status: 'Cancelling', detail: 'Stopping current response', transport: currentTransportLabel(), interruptible: false });
  setRemoteMeter(6);
  queueWakeCooldown(1200);
  refreshModeUi();
}

function finishPlayback() {
  stopBargeInLoop();
  state.isSpeaking = false;
  els.interruptButton.disabled = true;
  els.interruptButton.classList.remove('live', 'armed');
  setRemoteMeter(6);
  queueWakeCooldown(1400);
  applyState({ phase: 'connected', status: 'Stand by', detail: state.interactionMode === MODES.PTT ? 'Hold to send' : 'Say “Hey”', transport: currentTransportLabel(), interruptible: true });
  refreshModeUi();
}

function revokeCurrentAudioUrl() {
  if (state.currentAudioUrl) {
    URL.revokeObjectURL(state.currentAudioUrl);
    state.currentAudioUrl = null;
  }
}

function setRemoteMeter(value) {
  els.remoteMeter.style.width = `${value}%`;
}

function isPublicTranscriptEntry(who) {
  return who === 'local' || who === 'remote';
}

function publicTranscriptLabel(who) {
  return who === 'local' ? 'You' : who === 'remote' ? 'Assistant' : who;
}

function saveTranscriptEntry(who, text, time) {
  if (!isPublicTranscriptEntry(who)) return;
  try {
    const entries = JSON.parse(localStorage.getItem(transcriptStorageKey) || '[]');
    entries.unshift({ who, text, time: time.toISOString() });
    while (entries.length > 20) entries.pop();
    localStorage.setItem(transcriptStorageKey, JSON.stringify(entries));
  } catch {}
}

function restoreTranscript() {
  try {
    const entries = JSON.parse(localStorage.getItem(transcriptStorageKey) || '[]');
    if (!entries.length) return;
    const placeholder = els.transcriptList.querySelector('.placeholder');
    if (placeholder) placeholder.remove();
    entries.filter(({ who }) => isPublicTranscriptEntry(who)).forEach(({ who, text, time }) => {
      const item = document.createElement('li');
      const meta = document.createElement('div');
      const body = document.createElement('div');
      meta.className = 'transcript-meta';
      body.className = 'transcript-text';
      meta.innerHTML = `<span>${publicTranscriptLabel(who)}</span><span>${formatTime(new Date(time))}</span>`;
      body.textContent = text;
      item.append(meta, body);
      item.style.opacity = '0.55';
      els.transcriptList.appendChild(item);
    });
  } catch {}
}

function addTranscript(who, text) {
  if (!isPublicTranscriptEntry(who)) {
    console.debug('[intercom]', who, text);
    return;
  }
  const placeholder = els.transcriptList.querySelector('.placeholder');
  if (placeholder) placeholder.remove();
  const now = new Date();
  saveTranscriptEntry(who, text, now);
  const item = document.createElement('li');
  const meta = document.createElement('div');
  const body = document.createElement('div');
  meta.className = 'transcript-meta';
  body.className = 'transcript-text';
  meta.innerHTML = `<span>${publicTranscriptLabel(who)}</span><span>${formatTime(now)}</span>`;
  body.textContent = text;
  item.append(meta, body);
  els.transcriptList.prepend(item);
  while (els.transcriptList.children.length > 20) {
    els.transcriptList.removeChild(els.transcriptList.lastElementChild);
  }
}

function clearTranscript() {
  els.transcriptList.innerHTML = '<li class="placeholder">Your conversation will appear here.</li>';
  try { localStorage.removeItem(transcriptStorageKey); } catch {}
}

function deriveVisualPhase({ phase, status, localSpeaking = false, remoteSpeaking = false }) {
  const normalized = String(status || '').toLowerCase();
  if (localSpeaking) return 'listening';
  if (remoteSpeaking || phase === 'speaking') return 'speaking';
  if (normalized.includes('transcribing')) return 'transcribing';
  if (normalized.includes('thinking') || normalized.includes('processing') || normalized.includes('sending') || normalized.includes('asking')) return 'processing';
  if (phase === 'error') return 'error';
  if (phase === 'connecting') return 'connecting';
  if (phase === 'connected') return 'live';
  return 'idle';
}

function setVisualPhase(visual) {
  const next = visual || 'idle';
  state.visualPhase = next;
  document.body.classList.remove('voice-state-idle', 'voice-state-live', 'voice-state-listening', 'voice-state-transcribing', 'voice-state-processing', 'voice-state-speaking', 'voice-state-connecting', 'voice-state-error');
  document.body.classList.add(`voice-state-${next}`);
  document.body.dataset.voiceState = next;
  syncProcessSound();
}

function applyState({ phase, status, detail, transport, interruptible, localSpeaking = false, remoteSpeaking = false }) {
  state.visualStatus = status;
  els.statusLabel.textContent = status;
  els.phaseLabel.textContent = detail;
  els.transportChip.textContent = transport === 'preview mode' ? 'preview mode' : (transport === 'offline' ? 'offline' : 'online');
  if (interruptible === true) {
    els.interruptChip.textContent = remoteSpeaking ? 'break in now' : 'cancel generation';
    els.interruptChip.classList.remove('subtle');
    els.interruptButton.disabled = !state.socket || state.socket.readyState !== WebSocket.OPEN;
    els.interruptButton.classList.toggle('live', remoteSpeaking);
    els.interruptButton.classList.toggle('armed', !remoteSpeaking);
  } else if (interruptible === false) {
    els.interruptChip.textContent = 'hold';
    els.interruptChip.classList.remove('subtle');
    els.interruptButton.disabled = true;
    els.interruptButton.classList.remove('live', 'armed');
  } else {
    els.interruptChip.textContent = 'interruptibility unknown';
    els.interruptChip.classList.add('subtle');
    els.interruptButton.disabled = true;
    els.interruptButton.classList.remove('live', 'armed');
  }

  els.halo.classList.remove('state-idle', 'state-connecting', 'state-live', 'state-speaking-local', 'state-speaking-remote', 'state-blocked');
  const map = {
    idle: 'state-idle',
    connecting: 'state-connecting',
    connected: 'state-live',
    speaking: 'state-speaking-remote',
    error: 'state-blocked'
  };
  let next = map[phase] || 'state-idle';
  if (localSpeaking) next = 'state-speaking-local';
  if (remoteSpeaking) next = 'state-speaking-remote';
  els.halo.classList.add(next);
  setVisualPhase(deriveVisualPhase({ phase, status, localSpeaking, remoteSpeaking }));
}

function setContinuousListen(enabled) {
  state.continuousListen = !!enabled;
  persistConfigFromInputs();
  if (els.continuousListenInput) els.continuousListenInput.checked = state.continuousListen;
  addTranscript('system', state.continuousListen ? 'Continuous listen enabled. Speak without a wake word.' : `Wake phrase required. Say “${state.wakePhrase}” to start.`);
  if (state.interactionMode === MODES.HANDSFREE) {
    stopWakeEngine();
    startWakeEngine();
  }
  syncProcessSound();
  refreshModeUi();
}

function setInteractionMode(mode) {

  if (mode === state.interactionMode) return;
  state.interactionMode = mode;
  persistConfigFromInputs();
  syncProcessSound();
  if (mode === MODES.HANDSFREE) {
    startWakeEngine();
    queueWakeCooldown(500);
    addTranscript('system', state.continuousListen ? 'Hands-free enabled. Continuous listen is on.' : `Hands-free enabled. Say “${state.wakePhrase}” to start a turn.`);
  } else {
    stopWakeEngine();
    addTranscript('system', 'Push-to-talk enabled. Hold the main button to speak.');
  }
  refreshModeUi();
  applyState({ phase: 'connected', status: 'Stand by', detail: mode === MODES.PTT ? 'Hold to send' : `Say “${state.wakePhrase}”`, transport: currentTransportLabel(), interruptible: true });
}

function refreshModeUi() {
  const connected = socketIsOpen() || state.config.demoMode;
  if (els.sessionChip) els.sessionChip.textContent = `session ${shortSessionToken()}`;
  if (els.wakePhraseChip) els.wakePhraseChip.textContent = `wake phrase: ${state.wakePhrase}`;
  const inHandsfree = state.interactionMode === MODES.HANDSFREE;

  els.pttModeButton.classList.toggle('active', !inHandsfree);
  els.handsfreeModeButton.classList.toggle('active', inHandsfree);

  if (inHandsfree) {
    els.talkTitle.textContent = state.isRecording ? 'Listening…' : 'Tap to speak now';
    els.talkHint.textContent = state.continuousListen ? 'Listening continuously' : `Or say “${state.wakePhrase}”`;
    els.modeHint.textContent = state.wakeAvailable
      ? (state.continuousListen ? 'Continuous listen uses local voice activity detection, then Whisper.' : `Wake phrase required: say “${state.wakePhrase}”.`)
      : 'Listener not armed yet — reconnecting or waiting for mic/hands-free mode.';
  } else {
    els.talkTitle.textContent = 'Hold to send';
    els.talkHint.textContent = 'Release to transmit';
    els.modeHint.textContent = 'Press and hold to speak.';
  }

  if (!inHandsfree) {
    state.handsfreeState = HF.OFF;
  } else if (!state.wakeAvailable) {
    state.handsfreeState = HF.UNAVAILABLE;
  } else if (state.isRecording) {
    state.handsfreeState = HF.CAPTURING;
  } else if (state.wakeArmed) {
    state.handsfreeState = HF.LISTENING;
  }

  const wakeText = state.wakeAvailable ? (state.wakeArmed ? (state.continuousListen ? 'continuous armed' : 'wake phrase armed') : `listening paused${state.wakeSuspendReason ? ` (${state.wakeSuspendReason})` : ''}`) : 'listener not armed';
  els.wakeChip.textContent = wakeText;
  els.wakeChip.classList.toggle('subtle', !state.wakeArmed);

  const hfLabelMap = {
    [HF.OFF]: 'hands-free off',
    [HF.LISTENING]: 'hands-free listening',
    [HF.SUSPENDED]: 'hands-free suspended',
    [HF.COOLDOWN]: 'wake cooldown',
    [HF.CAPTURING]: 'hands-free capturing',
    [HF.UNAVAILABLE]: 'hands-free tap mode'
  };
  els.handsfreeChip.textContent = hfLabelMap[state.handsfreeState] || 'hands-free off';
  els.handsfreeChip.classList.toggle('subtle', state.handsfreeState === HF.OFF || state.handsfreeState === HF.UNAVAILABLE);

  if (inHandsfree && state.wakeArmed && !state.isRecording && !state.isSpeaking && !['transcribing', 'processing', 'speaking', 'error', 'connecting'].includes(state.visualPhase)) {
    setVisualPhase('listening');
  }

  els.manualWakeButton.disabled = !inHandsfree || !connected || state.isSpeaking || state.isRecording;
  if (els.continuousListenInput) els.continuousListenInput.disabled = !inHandsfree;
}

function startWakeEngine() {
  if (state.interactionMode !== MODES.HANDSFREE) return;
  if (!socketIsOpen() && !state.config.demoMode) {
    state.wakeAvailable = false;
    state.wakeArmed = false;
    state.handsfreeState = HF.UNAVAILABLE;
    refreshModeUi();
    if (state.wasConnected) {
      clearTimeout(state.reconnectTimer);
      state.reconnectTimer = setTimeout(() => connect(), 500);
    }
    return;
  }
  if (!state.mediaStream || !window.MediaRecorder) {
    state.wakeAvailable = false;
    state.wakeArmed = false;
    state.handsfreeState = HF.UNAVAILABLE;
    refreshModeUi();
    return;
  }

  state.wakeAvailable = true;
  armWake();
}


function startBargeInLoop(mode = 'generation') {
  if (!state.mediaStream || !state.socket || state.socket.readyState !== WebSocket.OPEN || state.config.demoMode) return;
  stopBargeInLoop();
  state.bargeMode = mode;
  state.bargeHotFrames = 0;
  scheduleBargeProbe(0);
}

function stopBargeInLoop() {
  clearTimeout(state.bargeTimer);
  state.bargeTimer = null;
  state.bargeHotFrames = 0;
  state.bargeInFlight = false;
  const recorder = state.bargeRecorder;
  state.bargeRecorder = null;
  if (recorder && recorder.state !== 'inactive') {
    try { recorder.stop(); } catch {}
  }
}

function scheduleBargeProbe(delayMs = BARGE_IN.retryMs) {
  clearTimeout(state.bargeTimer);
  state.bargeTimer = setTimeout(() => {
    if (!state.socket || state.socket.readyState !== WebSocket.OPEN || !state.mediaStream) return;
    if (state.isRecording || state.bargeRecorder || state.bargeInFlight) return scheduleBargeProbe(BARGE_IN.retryMs);
    const threshold = state.bargeMode === 'playback' ? BARGE_IN.playbackStartLevel : BARGE_IN.generationStartLevel;
    if (state.localLevel >= threshold) state.bargeHotFrames += 1;
    else state.bargeHotFrames = 0;
    if (state.bargeHotFrames >= BARGE_IN.hotFramesToStart) {
      state.bargeHotFrames = 0;
      startBargeProbeRecorder();
    } else {
      scheduleBargeProbe(BARGE_IN.checkMs);
    }
  }, delayMs);
}

function startBargeProbeRecorder() {
  if (!state.mediaStream || state.bargeRecorder || state.bargeInFlight) return;
  const mimeType = pickMimeType();
  const recorder = mimeType ? new MediaRecorder(state.mediaStream, { mimeType }) : new MediaRecorder(state.mediaStream);
  state.bargeRecorder = recorder;
  state.bargeChunks = [];
  recorder.addEventListener('dataavailable', (event) => {
    if (event.data && event.data.size > 0) state.bargeChunks.push(event.data);
  });
  recorder.addEventListener('stop', async () => {
    const chunks = state.bargeChunks;
    state.bargeChunks = [];
    state.bargeRecorder = null;
    if (!chunks.length || state.socket?.readyState !== WebSocket.OPEN) return scheduleBargeProbe(BARGE_IN.retryMs);
    state.bargeInFlight = true;
    const blob = new Blob(chunks, { type: recorder.mimeType || 'application/octet-stream' });
    const buffer = await blob.arrayBuffer();
    if (buffer.byteLength > 0 && state.socket?.readyState === WebSocket.OPEN) {
      sendJson({ type: 'barge_probe_start', mode: state.bargeMode });
      state.socket.send(buffer);
      sendJson({ type: 'barge_probe_end', mode: state.bargeMode });
    }
    setTimeout(() => {
      if (!state.bargeInFlight) return;
      state.bargeInFlight = false;
      scheduleBargeProbe(BARGE_IN.retryMs);
    }, 2500);
  }, { once: true });
  recorder.start();
  setTimeout(() => {
    if (recorder.state !== 'inactive') recorder.stop();
  }, state.bargeMode === 'playback' ? BARGE_IN.playbackProbeMs : BARGE_IN.generationProbeMs);
}


function startPreRollBuffer() {
  if (!state.continuousListen || state.preRollRecorder || !state.mediaStream || state.isRecording || state.isSpeaking) return;
  const mimeType = pickMimeType();
  const recorder = mimeType ? new MediaRecorder(state.mediaStream, { mimeType }) : new MediaRecorder(state.mediaStream);
  state.preRollRecorder = recorder;
  state.preRollChunks = [];
  recorder.addEventListener('dataavailable', (event) => {
    if (!event.data || event.data.size <= 0) return;
    state.preRollChunks.push(event.data);
    while (state.preRollChunks.length > PRE_ROLL.maxChunks) state.preRollChunks.shift();
  });
  recorder.addEventListener('stop', () => {
    if (state.preRollRecorder === recorder) state.preRollRecorder = null;
  });
  try { recorder.start(PRE_ROLL.sliceMs); } catch { state.preRollRecorder = null; }
}

function takePreRollChunks() {
  const chunks = [...state.preRollChunks];
  state.preRollChunks = [];
  const recorder = state.preRollRecorder;
  state.preRollRecorder = null;
  if (recorder && recorder.state !== 'inactive') {
    try { recorder.stop(); } catch {}
  }
  return chunks;
}

function stopPreRollBuffer() {
  state.preRollChunks = [];
  const recorder = state.preRollRecorder;
  state.preRollRecorder = null;
  if (recorder && recorder.state !== 'inactive') {
    try { recorder.stop(); } catch {}
  }
}

function startLocalVadLoop() {
  stopLocalVadLoop();
  state.vadHotFrames = 0;
  startPreRollBuffer();
  state.vadTimer = setInterval(() => {
    if (!state.wakeArmed || state.interactionMode !== MODES.HANDSFREE || !state.continuousListen) return;
    if (state.isSpeaking || state.isRecording || state.wakeProbeInFlight) return;
    if (state.localLevel >= LOCAL_VAD.startLevel) state.vadHotFrames += 1;
    else state.vadHotFrames = 0;
    if (state.vadHotFrames >= LOCAL_VAD.hotFramesToStart) {
      const level = Math.round(state.localLevel * 10) / 10;
      state.vadHotFrames = 0;
      const preRollChunks = takePreRollChunks();
      sendJson({ type: 'client_event', event: 'vad_trigger', level, preRollChunks: preRollChunks.length });
      triggerHandsfreeCapture('voice activity', preRollChunks);
    }
  }, LOCAL_VAD.checkMs);
}

function stopLocalVadLoop() {
  clearInterval(state.vadTimer);
  state.vadTimer = null;
  state.vadHotFrames = 0;
  stopPreRollBuffer();
}

function stopWakeProbeRecorder() {
  clearTimeout(state.wakeProbeTimer);
  state.wakeProbeTimer = null;
  const recorder = state.wakeProbeRecorder;
  state.wakeProbeRecorder = null;
  if (recorder && recorder.state !== 'inactive') {
    try { recorder.stop(); } catch {}
  }
}

function stopWakeEngine() {
  clearTimeout(state.wakeCooldownTimer);
  state.wakeCooldownTimer = null;
  state.wakeArmed = false;
  state.wakeSuspendReason = '';
  stopWakeProbeRecorder();
  stopLocalVadLoop();
  state.wakeProbeInFlight = false;
  state.wakeProbeChunks = [];
  state.handsfreeState = HF.OFF;
  refreshModeUi();
}

function startWakeProbeRecorder() {
  if (!state.wakeArmed || state.wakeProbeRecorder || state.wakeProbeInFlight) return;
  if (!state.mediaStream || !state.socket || state.socket.readyState !== WebSocket.OPEN) return;
  if (state.isSpeaking || state.isRecording || state.config.demoMode) return;

  const mimeType = pickMimeType();
  const recorder = mimeType ? new MediaRecorder(state.mediaStream, { mimeType }) : new MediaRecorder(state.mediaStream);
  state.wakeProbeRecorder = recorder;
  state.wakeProbeChunks = [];

  recorder.addEventListener('dataavailable', (event) => {
    if (event.data && event.data.size > 0) state.wakeProbeChunks.push(event.data);
  });

  recorder.addEventListener('stop', async () => {
    const chunks = state.wakeProbeChunks;
    state.wakeProbeChunks = [];
    state.wakeProbeRecorder = null;
    if (!state.wakeArmed || state.isSpeaking || state.isRecording || !chunks.length || state.socket?.readyState !== WebSocket.OPEN) {
      scheduleNextWakeProbe(state.continuousListen ? LISTEN_PROBE.continuousRetryMs : 500);
      return;
    }

    state.wakeProbeInFlight = true;
    const blob = new Blob(chunks, { type: recorder.mimeType || 'application/octet-stream' });
    const buffer = await blob.arrayBuffer();
    if (buffer.byteLength > 0 && state.socket?.readyState === WebSocket.OPEN) {
      sendJson({ type: 'wake_probe_start', mode: state.continuousListen ? 'continuous' : 'wake' });
      state.socket.send(buffer);
      sendJson({ type: 'wake_probe_end', mode: state.continuousListen ? 'continuous' : 'wake' });
    }
    // Server response will clear in-flight; timeout keeps the loop alive if a response is dropped.
    setTimeout(() => {
      if (!state.wakeProbeInFlight) return;
      state.wakeProbeInFlight = false;
      scheduleNextWakeProbe(LISTEN_PROBE.droppedResponseRetryMs);
    }, 3500);
  }, { once: true });

  recorder.start();
  const probeMs = state.continuousListen ? LISTEN_PROBE.continuousMs : LISTEN_PROBE.wakePhraseMs;
  state.wakeProbeTimer = setTimeout(() => {
    if (recorder.state !== 'inactive') recorder.stop();
  }, probeMs);
}

function scheduleNextWakeProbe(ms = 250) {
  clearTimeout(state.wakeCooldownTimer);
  if (!state.wakeArmed || state.interactionMode !== MODES.HANDSFREE || state.isSpeaking || state.isRecording) return;
  if (state.continuousListen) {
    startLocalVadLoop();
    return;
  }
  state.wakeCooldownTimer = setTimeout(() => startWakeProbeRecorder(), ms);
}

function armWake() {
  if (!state.wakeAvailable || state.interactionMode !== MODES.HANDSFREE || state.isSpeaking || state.isRecording) return;
  state.wakeArmed = true;
  state.wakeSuspendReason = '';
  state.handsfreeState = HF.LISTENING;
  refreshModeUi();
  if (state.continuousListen) startLocalVadLoop();
  else scheduleNextWakeProbe(100);
}

function suspendWake(reason = '') {
  if (!state.wakeAvailable) return;
  state.wakeArmed = false;
  state.wakeSuspendReason = reason;
  state.handsfreeState = HF.SUSPENDED;
  stopWakeProbeRecorder();
  stopLocalVadLoop();
  refreshModeUi();
}

function queueWakeCooldown(ms = 1200) {
  if (state.interactionMode !== MODES.HANDSFREE) return;
  clearTimeout(state.wakeCooldownTimer);

  // Continuous listen should feel armed, not stuck in a visible cooldown state.
  // The delay is only a debounce before rechecking VAD.
  if (state.continuousListen) {
    state.wakeArmed = false;
    state.handsfreeState = HF.LISTENING;
    refreshModeUi();
    state.wakeCooldownTimer = setTimeout(() => {
      if (state.interactionMode !== MODES.HANDSFREE || state.isSpeaking || state.isRecording) return;
      armWake();
    }, Math.min(ms, 250));
    return;
  }

  state.wakeArmed = false;
  state.handsfreeState = HF.COOLDOWN;
  refreshModeUi();
  state.wakeCooldownTimer = setTimeout(() => {
    if (state.interactionMode !== MODES.HANDSFREE || state.isSpeaking || state.isRecording) return;
    armWake();
  }, ms);
}

function triggerHandsfreeCapture(source, initialChunks = []) {
  if (state.interactionMode !== MODES.HANDSFREE) return;
  const connected = socketIsOpen() || state.config.demoMode;
  if (!connected) {
    addTranscript('system', 'Listener is reconnecting; try again in a moment.');
    if (state.wasConnected) connect();
    refreshModeUi();
    return;
  }
  if (state.isSpeaking || state.isRecording) return;

  addTranscript('system', source === 'wake word' ? (state.continuousListen ? 'Voice detected.' : `Wake detected: ${state.wakePhrase}`) : `Hands-free trigger: ${source}`);
  suspendWake('capturing');
  state.handsfreeState = HF.CAPTURING;
  startRecording(source === 'wake word' ? 'wakeword' : 'handsfree-manual', initialChunks);
  if (!state.isRecording) queueWakeCooldown(900);
}

function scrubUrl(value) {
  try {
    const url = new URL(value);
    return `${url.protocol}//${url.host}`;
  } catch {
    return 'relay';
  }
}

function formatTime(date) {
  return new Intl.DateTimeFormat([], { hour: '2-digit', minute: '2-digit' }).format(date);
}

function registerServiceWorker() {
  // manifest.webmanifest and sw.js were removed during cleanup — no-op
}
