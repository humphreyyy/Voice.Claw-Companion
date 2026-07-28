import { setupProductPolicy } from './product-policy.js';

export const VOICECLAW_SETUP_SCHEMA_VERSION = 3;
export const VOICECLAW_SETUP_MINIMUM_READER_VERSION = 2;

export const VOICECLAW_SETUP_CAPABILITIES = Object.freeze({
  routeTasks: 1,
  taskInputAttachments: 1,
  artifactInbox: 1,
  taskEvents: 1,
  codexThreads: 1,
  hermesGateway: 1,
});

export const VOICECLAW_SETUP_LIMITS = Object.freeze({
  artifactFileBytes: 52_428_800,
  artifactInboxBytes: 524_288_000,
  inputAttachmentFileBytes: 52_428_800,
  inputAttachmentStoreBytes: 524_288_000,
  inputAttachmentsPerTask: 20,
  inputAttachmentOrphanRetentionSeconds: 86_400,
});

const LEGACY_SETUP_CAPABILITIES = Object.freeze({
  routeTasks: 0,
  taskInputAttachments: 0,
  artifactInbox: 0,
  taskEvents: 0,
  codexThreads: 0,
  hermesGateway: 0,
});

const OPENAI_API_KEY_FIELDS = Object.freeze([
  'OpenAIAPIKey',
  'openAIAPIKey',
  'openAIApiKey',
  'openaiAPIKey',
  'openaiApiKey',
  'apiKey',
]);

const CEREBRAS_API_KEY_FIELDS = Object.freeze([
  'CerebrasAPIKey',
  'cerebrasAPIKey',
  'cerebrasApiKey',
]);

const BRIDGE_CREDENTIAL_FIELDS = Object.freeze([
  'OpenClawGatewayToken',
  'OpenClawGatewayPassword',
  'gatewayToken',
  'gatewayPassword',
]);

const CHATGPT_OAUTH_FIELDS = Object.freeze([
  'ChatGPTOAuthAccessToken',
  'ChatGPTOAuthRefreshToken',
  'ChatGPTOAuthExpiresAt',
  'ChatGPTOAuthAccountID',
  'openAIChatGPTOAuthAccessToken',
  'openAIChatGPTOAuthRefreshToken',
  'openAIChatGPTOAuthExpiresAt',
  'openAIChatGPTOAuthAccountID',
  'openAIOAuthAccessToken',
  'openAIOAuthRefreshToken',
  'openAIOAuthExpiresAt',
  'openAIOAuthAccountID',
]);

const DEVICE_EXPERIENCE_PREFERENCE_FIELDS = new Set([
  'RealtimeVoiceEngine', 'realtimeVoiceEngine', 'IPhoneRealtimeVoiceEngine',
  'RouteMode', 'routeMode', 'IPhoneRouteMode', 'WatchRouteMode', 'WatchEffectiveVoiceEngine',
  'RealtimeModel', 'realtimeModel', 'RealtimeVoice', 'realtimeVoice',
  'ReasoningEffort', 'reasoningEffort',
  'InstantModel', 'instantModel', 'InstantWebSearch', 'instantWebSearch',
  'GPT55DirectReasoning', 'gpt55DirectReasoning',
  'OpenClawModel', 'openClawModel', 'OpenClawReasoning', 'openClawReasoning',
  'OpenClawVerbatimPassThrough', 'openClawVerbatimPassThrough',
  'RealtimeAuthMode', 'realtimeAuthMode',
  'RealtimeAuthFallbackToAPIKey', 'realtimeAuthFallbackToAPIKey',
  'TurnDetection', 'turnDetection', 'NoiseReduction', 'noiseReduction',
  'CompanionVoiceMiddleBrainMode', 'companionVoiceMiddleBrainMode',
  'CompanionVoiceCerebrasModelID', 'companionVoiceCerebrasModelID',
  'CompanionVoiceSTTProfile', 'companionVoiceSTTProfile',
  'CompanionVoiceTTSVoice', 'companionVoiceTTSVoice',
  'CompanionVoiceQwenThinkingEnabled', 'companionVoiceQwenThinkingEnabled',
  'CompanionVoiceStreamingTransportEnabled', 'companionVoiceStreamingTransportEnabled',
  'CompanionVoiceVADSensitivity', 'companionVoiceVADSensitivity',
  'CompanionVoiceVADSilenceDuration', 'companionVoiceVADSilenceDuration',
  'SpeechRecognitionSource', 'speechRecognitionSource',
  'SpeechOutputSource', 'speechOutputSource',
  'TurnBasedGPTModel', 'turnBasedGPTModel',
  'STTGPTTTSGPTModel', 'sttGPTTTSGPTModel',
  'PowerhouseMode', 'powerhouseMode', 'CompanionPowerhouseMode', 'companionPowerhouseMode',
  'MicrophonePreference', 'microphonePreference',
  'UseSpeakerphoneForAudioOutput', 'useSpeakerphoneForAudioOutput',
  'ProtectLiveSessionAudio', 'protectLiveSessionAudio',
  'LiveCaptions', 'liveCaptions', 'AutoStartMic', 'autoStartMic',
  'ProactivityMode', 'proactivityMode',
  'KeepScreenAwakeDuringLiveSession', 'keepScreenAwakeDuringLiveSession',
  'HandoffAssistEnabled', 'handoffAssistEnabled',
  'AppAppearance', 'appAppearance',
]);

/**
 * Setup QR documents provision connectivity, credentials, runtime identity,
 * and advertised capabilities. Engine, route, model, authentication-mode, and
 * other device-owned experience choices remain on the phone. Unknown fields
 * are deliberately retained for forward compatibility.
 */
export function removeDeviceExperiencePreferences(payload = {}) {
  return Object.fromEntries(
    Object.entries(payload).filter(([key]) => !DEVICE_EXPERIENCE_PREFERENCE_FIELDS.has(key)),
  );
}

/**
 * Applies the user's explicit setup-secret inclusion choices. Unknown fields
 * are retained so an older Companion cannot shrink a newer setup document.
 */
export function applySetupSecretPolicy(payload = {}, options = {}) {
  const result = { ...payload };
  const policies = [
    [options.includeOpenAIAPIKey !== false, OPENAI_API_KEY_FIELDS],
    [options.includeCerebrasAPIKey !== false, CEREBRAS_API_KEY_FIELDS],
    [options.includeBridgeCredentials !== false, BRIDGE_CREDENTIAL_FIELDS],
    [options.includeChatGPTOAuth !== false, CHATGPT_OAUTH_FIELDS],
  ];

  for (const [included, fields] of policies) {
    if (included) continue;
    for (const field of fields) delete result[field];
  }
  return result;
}

function objectDictionary(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
}

function setupSchemaVersion(payload = {}) {
  const raw = Number(payload.setupSchemaVersion ?? payload.VoiceClawSetupVersion ?? 1);
  return Number.isSafeInteger(raw) && raw > 0 ? raw : 1;
}

/**
 * Interprets an imported setup document without making capability absence an
 * error. V1 and early V2 documents predate explicit capability advertising;
 * their flat bridge fields remain usable while additive V3 endpoints are
 * treated as unavailable until a current Companion advertises them.
 */
export function setupCompatibilityProfile(payload = {}) {
  const advertised = objectDictionary(payload.capabilities);
  const hasExplicitCapabilities = Object.keys(advertised).length > 0;
  const capabilities = { ...LEGACY_SETUP_CAPABILITIES };
  if (hasExplicitCapabilities) {
    for (const key of Object.keys(capabilities)) {
      const value = Number(advertised[key] ?? 0);
      capabilities[key] = Number.isFinite(value) && value > 0 ? Math.trunc(value) : 0;
    }
  }
  return {
    sourceSchemaVersion: setupSchemaVersion(payload),
    mode: hasExplicitCapabilities ? 'capability-advertised' : 'legacy-flat',
    hasExplicitCapabilities,
    capabilities,
    legacy: {
      flatSetupFields: true,
      setupDeepLink: true,
      openClawTurn: true,
    },
  };
}

/**
 * Adds the current additive setup contract without removing legacy flat keys.
 * Keeping VoiceClawSetupVersion allows older iOS builds to continue importing
 * the payload while newer readers negotiate capabilities explicitly.
 */
export function decorateSetupPayload(payload = {}) {
  const existingCapabilities = objectDictionary(payload.capabilities);
  const existingLimits = objectDictionary(payload.limits);
  const existingProductSurfaces = objectDictionary(payload.productSurfaces);
  return {
    ...payload,
    VoiceClawSetupVersion: VOICECLAW_SETUP_SCHEMA_VERSION,
    setupSchemaVersion: VOICECLAW_SETUP_SCHEMA_VERSION,
    minimumReaderVersion: VOICECLAW_SETUP_MINIMUM_READER_VERSION,
    capabilities: { ...existingCapabilities, ...VOICECLAW_SETUP_CAPABILITIES },
    limits: { ...existingLimits, ...VOICECLAW_SETUP_LIMITS },
    productSurfaces: { ...existingProductSurfaces, ...setupProductPolicy() },
  };
}
