import assert from 'node:assert/strict';
import test from 'node:test';

import {
  VOICECLAW_SETUP_CAPABILITIES,
  VOICECLAW_SETUP_LIMITS,
  applySetupSecretPolicy,
  decorateSetupPayload,
  setupCompatibilityProfile,
} from '../server/setup-contract.js';
import { setupProductPolicy } from '../server/product-policy.js';

test('schema v3 decorates the complete legacy payload without dropping unknown fields', () => {
  const payload = decorateSetupPayload({
    VoiceClawSetupVersion: 2,
    TailscaleBaseURL: 'https://mac.example.ts.net',
    FutureNonSecretSetting: { enabled: true, revision: 7 },
  });

  assert.equal(payload.VoiceClawSetupVersion, 3);
  assert.equal(payload.setupSchemaVersion, 3);
  assert.equal(payload.minimumReaderVersion, 2);
  assert.equal(payload.TailscaleBaseURL, 'https://mac.example.ts.net');
  assert.deepEqual(payload.FutureNonSecretSetting, { enabled: true, revision: 7 });
  assert.deepEqual(payload.capabilities, VOICECLAW_SETUP_CAPABILITIES);
  assert.deepEqual(payload.limits, VOICECLAW_SETUP_LIMITS);
  assert.deepEqual(payload.productSurfaces, setupProductPolicy());
});

test('schema v1, v2, and v3 payloads upgrade additively and retain unknown nested contract fields', () => {
  for (const sourceVersion of [1, 2, 3]) {
    const payload = decorateSetupPayload({
      VoiceClawSetupVersion: sourceVersion,
      setupSchemaVersion: sourceVersion,
      LegacyFlatSetting: `v${sourceVersion}`,
      capabilities: { futureRouteRuntime: 7, routeTasks: 0 },
      limits: { futureTransferBytes: 1234, artifactFileBytes: 1 },
      productSurfaces: { futureSurfaceVisible: true, powerhouseVisible: true },
    });

    assert.equal(payload.VoiceClawSetupVersion, 3);
    assert.equal(payload.setupSchemaVersion, 3);
    assert.equal(payload.LegacyFlatSetting, `v${sourceVersion}`);
    assert.equal(payload.capabilities.futureRouteRuntime, 7);
    assert.equal(payload.capabilities.routeTasks, 1);
    assert.equal(payload.limits.futureTransferBytes, 1234);
    assert.equal(payload.limits.artifactFileBytes, VOICECLAW_SETUP_LIMITS.artifactFileBytes);
    assert.equal(payload.productSurfaces.futureSurfaceVisible, true);
    assert.equal(payload.productSurfaces.powerhouseVisible, false);
  }
});

test('capability absence maps old setup documents to legacy flat behavior', () => {
  for (const payload of [
    { VoiceClawSetupVersion: 1, TailscaleBaseURL: 'https://legacy-v1.example' },
    { VoiceClawSetupVersion: 2, setupSchemaVersion: 2 },
  ]) {
    const profile = setupCompatibilityProfile(payload);
    assert.equal(profile.mode, 'legacy-flat');
    assert.equal(profile.hasExplicitCapabilities, false);
    assert.equal(profile.legacy.flatSetupFields, true);
    assert.equal(profile.legacy.setupDeepLink, true);
    assert.equal(profile.legacy.openClawTurn, true);
    assert.deepEqual(profile.capabilities, {
      routeTasks: 0,
      taskInputAttachments: 0,
      artifactInbox: 0,
      taskEvents: 0,
      codexThreads: 0,
      hermesGateway: 0,
    });
  }

  const advertised = setupCompatibilityProfile({
    setupSchemaVersion: 3,
    capabilities: { routeTasks: 1, artifactInbox: 2 },
  });
  assert.equal(advertised.mode, 'capability-advertised');
  assert.equal(advertised.capabilities.routeTasks, 1);
  assert.equal(advertised.capabilities.artifactInbox, 2);
  assert.equal(advertised.capabilities.taskInputAttachments, 0);
});

test('schema v3 advertises the exact artifact limits', () => {
  assert.equal(VOICECLAW_SETUP_CAPABILITIES.routeTasks, 1);
  assert.equal(VOICECLAW_SETUP_CAPABILITIES.taskInputAttachments, 1);
  assert.equal(VOICECLAW_SETUP_CAPABILITIES.artifactInbox, 1);
  assert.equal(VOICECLAW_SETUP_CAPABILITIES.taskEvents, 1);
  assert.equal(VOICECLAW_SETUP_LIMITS.artifactFileBytes, 52_428_800);
  assert.equal(VOICECLAW_SETUP_LIMITS.artifactInboxBytes, 524_288_000);
  assert.equal(VOICECLAW_SETUP_LIMITS.inputAttachmentFileBytes, 52_428_800);
  assert.equal(VOICECLAW_SETUP_LIMITS.inputAttachmentStoreBytes, 524_288_000);
  assert.equal(VOICECLAW_SETUP_LIMITS.inputAttachmentsPerTask, 20);
  assert.equal(VOICECLAW_SETUP_LIMITS.inputAttachmentOrphanRetentionSeconds, 86_400);
});

test('secret policy removes only explicitly excluded secret families', () => {
  const filtered = applySetupSecretPolicy({
    OpenAIAPIKey: 'sk-test',
    CerebrasAPIKey: 'csk-test',
    gatewayToken: 'gateway-test',
    OpenClawGatewayPassword: 'password-test',
    ChatGPTOAuthAccessToken: 'oauth-test',
    ChatGPTOAuthAccountID: 'account-test',
    FutureNonSecretSetting: { enabled: true },
  }, {
    includeOpenAIAPIKey: false,
    includeCerebrasAPIKey: true,
    includeBridgeCredentials: false,
    includeChatGPTOAuth: false,
  });

  assert.equal(filtered.OpenAIAPIKey, undefined);
  assert.equal(filtered.CerebrasAPIKey, 'csk-test');
  assert.equal(filtered.gatewayToken, undefined);
  assert.equal(filtered.OpenClawGatewayPassword, undefined);
  assert.equal(filtered.ChatGPTOAuthAccessToken, undefined);
  assert.equal(filtered.ChatGPTOAuthAccountID, undefined);
  assert.deepEqual(filtered.FutureNonSecretSetting, { enabled: true });
});

test('secret inclusion keeps every existing alias and unknown non-secret field', () => {
  const payload = {
    openAIApiKey: 'legacy-openai',
    cerebrasApiKey: 'legacy-cerebras',
    gatewayPassword: 'legacy-gateway-password',
    openAIOAuthRefreshToken: 'legacy-oauth-refresh',
    FutureNonSecretSetting: { nested: true },
  };
  const retained = applySetupSecretPolicy(payload, {
    includeOpenAIAPIKey: true,
    includeCerebrasAPIKey: true,
    includeBridgeCredentials: true,
    includeChatGPTOAuth: true,
  });
  assert.deepEqual(retained, payload);
  assert.notEqual(retained, payload);
});
