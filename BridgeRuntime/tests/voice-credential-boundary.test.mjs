import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import WebSocket from 'ws';

import {
  VOICE_CREDENTIAL_DELEGATION_KIND,
  VOICE_CREDENTIAL_DELEGATION_FIELD,
  VOICE_CREDENTIAL_DELEGATION_SCHEMA_VERSION,
  VOICE_CREDENTIAL_MAX_CLOCK_SKEW_MS,
  VOICE_CREDENTIAL_MAX_TTL_MS,
  VOICE_CREDENTIAL_TRANSPORT_PRECONDITION,
  VoiceCredentialBoundaryError,
  VoiceCredentialErrorCode,
  VoiceCredentialSecretCategory,
  accessTokenFromValidatedVoiceAccessTokenDelegation,
  assertVoiceControlPayloadCredentialSafe,
  enforceVoiceCredentialBoundaryOnControlPayload,
  isConfidentialVoiceCredentialTransport,
  isTrueLoopbackVoiceCredentialPeerAddress,
  sanitizeVoiceControlPayload,
  validateVoiceAccessTokenDelegation,
  validatedVoiceAccessTokenDelegationForPayload,
  voiceCredentialTransportFromNodeRequest,
} from '../server/voice-credential-boundary.js';

const NOW = 1_800_000_000_000;
const ACCESS_TOKEN = 'delegated-access-token-value';
const SECURE_WSS = Object.freeze({
  protocol: 'wss:',
  peerAddress: '203.0.113.10',
});

function envelope(overrides = {}) {
  return {
    schemaVersion: VOICE_CREDENTIAL_DELEGATION_SCHEMA_VERSION,
    kind: VOICE_CREDENTIAL_DELEGATION_KIND,
    transportSecurity: VOICE_CREDENTIAL_TRANSPORT_PRECONDITION,
    accessToken: ACCESS_TOKEN,
    issuedAtEpochMilliseconds: NOW,
    expiresAtEpochMilliseconds: NOW + 120_000,
    accountID: 'account-123',
    provider: 'openai',
    scopes: ['voice.write', 'account/read'],
    ...overrides,
  };
}

function expectBoundaryError(operation, code, path = undefined, forbiddenValues = []) {
  let caught;
  try {
    operation();
  } catch (error) {
    caught = error;
  }
  assert.ok(caught instanceof VoiceCredentialBoundaryError);
  assert.equal(caught.code, code);
  assert.equal(caught.path, path);
  for (const value of forbiddenValues) {
    assert.equal(caught.message.includes(value), false);
    assert.equal(JSON.stringify(caught).includes(value), false);
  }
  return caught;
}

test('constants and stable error codes match the iOS wire contract', () => {
  assert.equal(VOICE_CREDENTIAL_DELEGATION_SCHEMA_VERSION, 1);
  assert.equal(VOICE_CREDENTIAL_DELEGATION_KIND, 'access_token_delegation');
  assert.equal(VOICE_CREDENTIAL_DELEGATION_FIELD, 'credentialDelegation');
  assert.equal(VOICE_CREDENTIAL_TRANSPORT_PRECONDITION, 'tls_or_true_loopback');
  assert.equal(VOICE_CREDENTIAL_MAX_TTL_MS, 300_000);
  assert.equal(VOICE_CREDENTIAL_MAX_CLOCK_SKEW_MS, 30_000);
  assert.deepEqual(VoiceCredentialErrorCode, {
    INSECURE_TRANSPORT: 'voice_credential_insecure_transport',
    REFRESH_TOKEN_FORBIDDEN: 'voice_credential_refresh_token_forbidden',
    MASTER_API_KEY_FORBIDDEN: 'voice_credential_master_api_key_forbidden',
    ACCESS_TOKEN_OUTSIDE_DELEGATION: 'voice_credential_access_token_outside_delegation',
    UNEXPECTED_SECRET_FIELD: 'voice_credential_unexpected_secret_field',
    INVALID_ENVELOPE: 'voice_credential_invalid_envelope',
    UNSUPPORTED_SCHEMA: 'voice_credential_unsupported_schema',
    INVALID_KIND: 'voice_credential_invalid_kind',
    INVALID_TRANSPORT_PRECONDITION: 'voice_credential_invalid_transport_precondition',
    MISSING_FIELD: 'voice_credential_missing_field',
    INVALID_FIELD: 'voice_credential_invalid_field',
    INVALID_SCOPE: 'voice_credential_invalid_scope',
    EXPIRED: 'voice_credential_expired',
    TTL_EXCEEDED: 'voice_credential_ttl_exceeded',
    ISSUED_AT_IN_FUTURE: 'voice_credential_issued_at_in_future',
    UNEXPECTED_FIELD: 'voice_credential_unexpected_field',
  });
});

test('valid envelope returns an exact canonical copy without mutating input', () => {
  const original = envelope();
  const validated = validateVoiceAccessTokenDelegation(
    original,
    SECURE_WSS,
    { nowEpochMilliseconds: NOW },
  );

  assert.deepEqual(validated, {
    schemaVersion: 1,
    kind: 'access_token_delegation',
    transportSecurity: 'tls_or_true_loopback',
    accessToken: ACCESS_TOKEN,
    issuedAtEpochMilliseconds: NOW,
    expiresAtEpochMilliseconds: NOW + 120_000,
    accountID: 'account-123',
    provider: 'openai',
    scopes: ['account/read', 'voice.write'],
  });
  assert.deepEqual(original.scopes, ['voice.write', 'account/read']);
  assert.notEqual(validated, original);
  assert.notEqual(validated.scopes, original.scopes);
});

test('transport policy trusts only actual protocol and numeric peer metadata', () => {
  for (const transport of [
    { protocol: 'https:' },
    { protocol: 'WSS', peerAddress: '198.51.100.4' },
    { protocol: 'http:', peerAddress: '127.0.0.1' },
    { protocol: 'ws:', peerAddress: '127.255.255.254' },
    { protocol: 'http', peerAddress: '::1' },
    { protocol: 'ws', peerAddress: '::ffff:127.0.0.1' },
  ]) {
    assert.equal(isConfidentialVoiceCredentialTransport(transport), true);
  }

  for (const transport of [
    { protocol: 'http:', peerAddress: '192.168.1.20' },
    { protocol: 'ws:', peerAddress: 'companion.local' },
    { protocol: 'http:', peerAddress: 'localhost' },
    { protocol: 'http:', peerAddress: '127.0.0.01' },
    { protocol: 'http:', peerAddress: '127.0.0' },
    { protocol: 'http:', peerAddress: '127.0.0.1', forwardedProtocol: 'https' },
    { scheme: 'https', peerAddress: '127.0.0.1' },
    { protocol: 'ftp:', peerAddress: '127.0.0.1' },
    null,
  ]) {
    const expected = transport?.forwardedProtocol === 'https';
    assert.equal(isConfidentialVoiceCredentialTransport(transport), expected);
  }

  assert.equal(isTrueLoopbackVoiceCredentialPeerAddress('[::1]'), true);
  assert.equal(isTrueLoopbackVoiceCredentialPeerAddress('::ffff:127.8.9.10'), true);
  assert.equal(isTrueLoopbackVoiceCredentialPeerAddress('127.0.0.256'), false);
  assert.equal(isTrueLoopbackVoiceCredentialPeerAddress(' 127.0.0.1'), false);
});

test('plaintext non-loopback rejects delegation regardless of token appearance or payload claims', () => {
  for (const transport of [
    { protocol: 'http:', peerAddress: '10.0.0.8' },
    { protocol: 'ws:', peerAddress: '203.0.113.8' },
    { protocol: 'http:', peerAddress: '10.0.0.8', encrypted: true },
    { protocol: 'http:', peerAddress: '10.0.0.8', host: 'localhost' },
  ]) {
    expectBoundaryError(
      () => validateVoiceAccessTokenDelegation(
        envelope({ accessToken: 'base64-looking-ciphertext' }),
        transport,
        { nowEpochMilliseconds: NOW },
      ),
      VoiceCredentialErrorCode.INSECURE_TRANSPORT,
    );
  }
});

test('recursive sanitizer removes known secrets, preserves control metadata, and never records values', () => {
  const secrets = {
    refresh: 'refresh-value-must-not-appear',
    master: 'master-value-must-not-appear',
    access: 'access-value-must-not-appear',
    client: 'client-value-must-not-appear',
    gateway: 'gateway-value-must-not-appear',
    private: 'private-value-must-not-appear',
  };
  const nullPrototype = Object.create(null);
  nullPrototype.gateway_token = secrets.gateway;
  nullPrototype.safe = 'foundation-kept';
  const payload = {
    safe: 'kept',
    refresh_token: secrets.refresh,
    nested: {
      'OpenAI-API-Key': secrets.master,
      hasAPIKey: true,
      realtimeAuthFallbackToAPIKey: true,
      sessionToken: 'voice-session-correlation-id',
      items: [
        { accessToken: secrets.access, tokenCount: 9 },
        { clientSecret: secrets.client, safe: 'nested-kept' },
      ],
    },
    foundation: nullPrototype,
    'a/b': { private_key: secrets.private },
  };

  const result = sanitizeVoiceControlPayload(payload);
  const expectedPaths = [
    '/refresh_token',
    '/nested/OpenAI-API-Key',
    '/nested/items/0/accessToken',
    '/nested/items/1/clientSecret',
    '/foundation/gateway_token',
    '/a~1b/private_key',
  ].sort();
  assert.deepEqual(result.removals.map(({ path }) => path), expectedPaths);
  assert.equal(result.payload.safe, 'kept');
  assert.equal(Object.hasOwn(result.payload, 'refresh_token'), false);
  assert.equal(Object.hasOwn(result.payload.nested, 'OpenAI-API-Key'), false);
  assert.equal(result.payload.nested.hasAPIKey, true);
  assert.equal(result.payload.nested.realtimeAuthFallbackToAPIKey, true);
  assert.equal(result.payload.nested.sessionToken, 'voice-session-correlation-id');
  assert.equal(result.payload.nested.items[0].tokenCount, 9);
  assert.equal(Object.hasOwn(result.payload.nested.items[0], 'accessToken'), false);
  assert.equal(result.payload.nested.items[1].safe, 'nested-kept');
  assert.equal(result.payload.foundation.safe, 'foundation-kept');
  assert.equal(Object.hasOwn(result.payload.foundation, 'gateway_token'), false);
  assert.equal(payload.refresh_token, secrets.refresh);
  assert.equal(payload.nested.items[0].accessToken, secrets.access);

  const audit = JSON.stringify(result.removals);
  for (const value of Object.values(secrets)) {
    assert.equal(audit.includes(value), false);
  }
  assert.deepEqual(sanitizeVoiceControlPayload(payload).removals, result.removals);
});

test('sanitizer handles prototype-shaped keys without prototype mutation', () => {
  const payload = {};
  Object.defineProperty(payload, '__proto__', {
    enumerable: true,
    value: { safe: true, apiKey: 'remove-me' },
  });
  const result = sanitizeVoiceControlPayload(payload);
  assert.equal(Object.getPrototypeOf(result.payload), Object.prototype);
  assert.equal(Object.hasOwn(result.payload, '__proto__'), true);
  assert.deepEqual(result.payload.__proto__, { safe: true });
  assert.equal(result.removals[0].path, '/__proto__/apiKey');
});

test('ordinary control validation uses deterministic category-specific failures', () => {
  expectBoundaryError(
    () => assertVoiceControlPayloadCredentialSafe({
      aApiKey: 'master-secret',
      zRefreshToken: 'refresh-secret',
    }),
    VoiceCredentialErrorCode.REFRESH_TOKEN_FORBIDDEN,
    '/zRefreshToken',
    ['master-secret', 'refresh-secret'],
  );
  expectBoundaryError(
    () => assertVoiceControlPayloadCredentialSafe({
      credentials: { providerApiKey: 'master-secret' },
    }),
    VoiceCredentialErrorCode.MASTER_API_KEY_FORBIDDEN,
    '/credentials/providerApiKey',
    ['master-secret'],
  );
  expectBoundaryError(
    () => assertVoiceControlPayloadCredentialSafe({ access_token: 'access-secret' }),
    VoiceCredentialErrorCode.ACCESS_TOKEN_OUTSIDE_DELEGATION,
    '/access_token',
    ['access-secret'],
  );
  expectBoundaryError(
    () => assertVoiceControlPayloadCredentialSafe({ client_secret: 'client-secret-value' }),
    VoiceCredentialErrorCode.UNEXPECTED_SECRET_FIELD,
    '/client_secret',
    ['client-secret-value'],
  );
  expectBoundaryError(
    () => assertVoiceControlPayloadCredentialSafe({ hasAPIKey: 'smuggled-master-key' }),
    VoiceCredentialErrorCode.MASTER_API_KEY_FORBIDDEN,
    '/hasAPIKey',
    ['smuggled-master-key'],
  );

  const clean = {
    hasAPIKey: true,
    realtimeAuthFallbackToAPIKey: true,
    sessionToken: 'voice-session-correlation-id',
    tokenCount: 42,
  };
  assert.equal(assertVoiceControlPayloadCredentialSafe(clean), clean);
});

test('envelope rejects refresh tokens, master keys, and hidden secret fields before use', () => {
  const cases = [
    {
      value: envelope({ refresh_token: 'refresh-secret' }),
      code: VoiceCredentialErrorCode.REFRESH_TOKEN_FORBIDDEN,
      path: '/refresh_token',
      secret: 'refresh-secret',
    },
    {
      value: envelope({ credentials: { providerApiKey: 'master-secret' } }),
      code: VoiceCredentialErrorCode.MASTER_API_KEY_FORBIDDEN,
      path: '/credentials/providerApiKey',
      secret: 'master-secret',
    },
    {
      value: envelope({ metadata: { accessToken: 'hidden-access-secret' } }),
      code: VoiceCredentialErrorCode.ACCESS_TOKEN_OUTSIDE_DELEGATION,
      path: '/metadata/accessToken',
      secret: 'hidden-access-secret',
    },
    {
      value: envelope({ metadata: { password: 'hidden-password' } }),
      code: VoiceCredentialErrorCode.UNEXPECTED_SECRET_FIELD,
      path: '/metadata/password',
      secret: 'hidden-password',
    },
  ];
  for (const item of cases) {
    expectBoundaryError(
      () => validateVoiceAccessTokenDelegation(
        item.value,
        SECURE_WSS,
        { nowEpochMilliseconds: NOW },
      ),
      item.code,
      item.path,
      [item.secret],
    );
  }
});

test('envelope shape, schema, kind, and transport precondition fail with stable paths', () => {
  expectBoundaryError(
    () => validateVoiceAccessTokenDelegation(null, SECURE_WSS, { nowEpochMilliseconds: NOW }),
    VoiceCredentialErrorCode.INVALID_ENVELOPE,
  );
  const missing = envelope();
  delete missing.accountID;
  expectBoundaryError(
    () => validateVoiceAccessTokenDelegation(missing, SECURE_WSS, { nowEpochMilliseconds: NOW }),
    VoiceCredentialErrorCode.MISSING_FIELD,
    '/accountID',
  );
  expectBoundaryError(
    () => validateVoiceAccessTokenDelegation(
      envelope({ schemaVersion: '1' }),
      SECURE_WSS,
      { nowEpochMilliseconds: NOW },
    ),
    VoiceCredentialErrorCode.INVALID_FIELD,
    '/schemaVersion',
  );
  expectBoundaryError(
    () => validateVoiceAccessTokenDelegation(
      envelope({ schemaVersion: 2 }),
      SECURE_WSS,
      { nowEpochMilliseconds: NOW },
    ),
    VoiceCredentialErrorCode.UNSUPPORTED_SCHEMA,
    '/schemaVersion',
  );
  expectBoundaryError(
    () => validateVoiceAccessTokenDelegation(
      envelope({ kind: 'refresh_token_delegation' }),
      SECURE_WSS,
      { nowEpochMilliseconds: NOW },
    ),
    VoiceCredentialErrorCode.INVALID_KIND,
    '/kind',
  );
  expectBoundaryError(
    () => validateVoiceAccessTokenDelegation(
      envelope({ transportSecurity: 'payload_encrypted' }),
      SECURE_WSS,
      { nowEpochMilliseconds: NOW },
    ),
    VoiceCredentialErrorCode.INVALID_TRANSPORT_PRECONDITION,
    '/transportSecurity',
  );
  expectBoundaryError(
    () => validateVoiceAccessTokenDelegation(
      envelope({ encryption: 'base64-over-http' }),
      SECURE_WSS,
      { nowEpochMilliseconds: NOW },
    ),
    VoiceCredentialErrorCode.UNEXPECTED_FIELD,
    '/encryption',
  );
});

test('expiry, issue time, and maximum TTL boundaries are enforced', () => {
  const maximumTTL = envelope({ expiresAtEpochMilliseconds: NOW + VOICE_CREDENTIAL_MAX_TTL_MS });
  assert.equal(
    validateVoiceAccessTokenDelegation(
      maximumTTL,
      SECURE_WSS,
      { nowEpochMilliseconds: NOW },
    ).expiresAtEpochMilliseconds,
    NOW + VOICE_CREDENTIAL_MAX_TTL_MS,
  );

  expectBoundaryError(
    () => validateVoiceAccessTokenDelegation(
      envelope({ expiresAtEpochMilliseconds: NOW }),
      SECURE_WSS,
      { nowEpochMilliseconds: NOW },
    ),
    VoiceCredentialErrorCode.EXPIRED,
    '/expiresAtEpochMilliseconds',
  );
  expectBoundaryError(
    () => validateVoiceAccessTokenDelegation(
      envelope({ expiresAtEpochMilliseconds: NOW + VOICE_CREDENTIAL_MAX_TTL_MS + 1 }),
      SECURE_WSS,
      { nowEpochMilliseconds: NOW },
    ),
    VoiceCredentialErrorCode.TTL_EXCEEDED,
    '/expiresAtEpochMilliseconds',
  );
  expectBoundaryError(
    () => validateVoiceAccessTokenDelegation(
      envelope({
        issuedAtEpochMilliseconds: NOW + VOICE_CREDENTIAL_MAX_CLOCK_SKEW_MS + 1,
        expiresAtEpochMilliseconds: NOW + VOICE_CREDENTIAL_MAX_CLOCK_SKEW_MS + 60_000,
      }),
      SECURE_WSS,
      { nowEpochMilliseconds: NOW },
    ),
    VoiceCredentialErrorCode.ISSUED_AT_IN_FUTURE,
    '/issuedAtEpochMilliseconds',
  );
  expectBoundaryError(
    () => validateVoiceAccessTokenDelegation(
      envelope({
        issuedAtEpochMilliseconds: NOW + 60_000,
        expiresAtEpochMilliseconds: NOW + 30_000,
      }),
      SECURE_WSS,
      { nowEpochMilliseconds: NOW },
    ),
    VoiceCredentialErrorCode.INVALID_FIELD,
    '/expiresAtEpochMilliseconds',
  );
  expectBoundaryError(
    () => validateVoiceAccessTokenDelegation(
      envelope({ issuedAtEpochMilliseconds: NOW + 0.5 }),
      SECURE_WSS,
      { nowEpochMilliseconds: NOW },
    ),
    VoiceCredentialErrorCode.INVALID_FIELD,
    '/issuedAtEpochMilliseconds',
  );
});

test('scope grammar, bounds, and uniqueness are exhaustive', () => {
  const invalidCases = [
    { scopes: [], path: '/scopes' },
    { scopes: new Array(33).fill(0).map((_, index) => `scope-${index}`), path: '/scopes' },
    { scopes: ['voice.read', 'voice.read'], path: '/scopes' },
    { scopes: 'voice.read', path: '/scopes' },
    { scopes: ['voice read'], path: '/scopes/0' },
    { scopes: ['voice?read'], path: '/scopes/0' },
    { scopes: ['/voice'], path: '/scopes/0' },
    { scopes: [''], path: '/scopes/0' },
    { scopes: [1], path: '/scopes/0' },
  ];
  for (const item of invalidCases) {
    expectBoundaryError(
      () => validateVoiceAccessTokenDelegation(
        envelope({ scopes: item.scopes }),
        SECURE_WSS,
        { nowEpochMilliseconds: NOW },
      ),
      VoiceCredentialErrorCode.INVALID_SCOPE,
      item.path,
    );
  }
});

test('token, account, provider, and timestamp types are strictly validated', () => {
  const invalidCases = [
    { overrides: { accessToken: '' }, path: '/accessToken' },
    { overrides: { accessToken: 'token with spaces' }, path: '/accessToken' },
    { overrides: { accountID: 'account with spaces' }, path: '/accountID' },
    { overrides: { provider: 'OpenAI' }, path: '/provider' },
    { overrides: { provider: 'openai/provider' }, path: '/provider' },
    { overrides: { expiresAtEpochMilliseconds: '1800000120000' }, path: '/expiresAtEpochMilliseconds' },
  ];
  for (const item of invalidCases) {
    expectBoundaryError(
      () => validateVoiceAccessTokenDelegation(
        envelope(item.overrides),
        SECURE_WSS,
        { nowEpochMilliseconds: NOW },
      ),
      VoiceCredentialErrorCode.INVALID_FIELD,
      item.path,
    );
  }
});

test('cyclic and accessor-backed dictionaries fail closed without evaluating accessors', () => {
  const cyclic = { safe: true };
  cyclic.self = cyclic;
  expectBoundaryError(
    () => sanitizeVoiceControlPayload(cyclic),
    VoiceCredentialErrorCode.INVALID_ENVELOPE,
    '/self',
  );

  let evaluated = false;
  const accessor = {};
  Object.defineProperty(accessor, 'safe', {
    enumerable: true,
    get() {
      evaluated = true;
      return 'value';
    },
  });
  expectBoundaryError(
    () => sanitizeVoiceControlPayload(accessor),
    VoiceCredentialErrorCode.INVALID_ENVELOPE,
    '/safe',
  );
  assert.equal(evaluated, false);
});

test('the canonical access token is still forbidden in ordinary payloads', () => {
  const ordinary = envelope();
  const sanitized = sanitizeVoiceControlPayload(ordinary);
  assert.equal(Object.hasOwn(sanitized.payload, 'accessToken'), false);
  assert.deepEqual(sanitized.removals, [{
    path: '/accessToken',
    field: 'accessToken',
    category: VoiceCredentialSecretCategory.ACCESS_TOKEN,
  }]);
  expectBoundaryError(
    () => assertVoiceControlPayloadCredentialSafe(ordinary),
    VoiceCredentialErrorCode.ACCESS_TOKEN_OUTSIDE_DELEGATION,
    '/accessToken',
  );
});

test('control ingress strips bridge auth, validates delegation, and privately binds it', () => {
  const request = {
    headers: {
      host: 'attacker.example',
      forwarded: 'for=203.0.113.9;proto=https',
      'x-forwarded-proto': 'https',
    },
    socket: {
      encrypted: false,
      remoteAddress: '127.0.0.1',
    },
  };
  const transport = voiceCredentialTransportFromNodeRequest(request, { webSocket: true });
  assert.deepEqual(transport, { protocol: 'ws:', peerAddress: '127.0.0.1' });

  const result = enforceVoiceCredentialBoundaryOnControlPayload({
    type: 'start_session',
    token: 'bridge-auth-token',
    [VOICE_CREDENTIAL_DELEGATION_FIELD]: envelope(),
    companionVoicePayload: { brainMode: 'qwen3.5-0.8b' },
  }, transport, {
    allowBridgeAuthenticationFields: true,
    nowEpochMilliseconds: NOW,
  });
  assert.deepEqual(result.payload, {
    type: 'start_session',
    companionVoicePayload: { brainMode: 'qwen3.5-0.8b' },
  });
  assert.equal(Object.hasOwn(result.payload, VOICE_CREDENTIAL_DELEGATION_FIELD), false);
  assert.equal(result.removals.some((removal) => removal.path === '/token'), true);
  assert.equal(
    validatedVoiceAccessTokenDelegationForPayload(
      result.payload,
      { nowEpochMilliseconds: NOW },
    ),
    result.credentialDelegation,
  );
  assert.equal(
    accessTokenFromValidatedVoiceAccessTokenDelegation(
      result.credentialDelegation,
      { nowEpochMilliseconds: NOW },
    ),
    ACCESS_TOKEN,
  );
  assert.equal(JSON.stringify(result.payload).includes(ACCESS_TOKEN), false);

  expectBoundaryError(
    () => enforceVoiceCredentialBoundaryOnControlPayload({
      type: 'start_session',
      token: 'bridge-auth-token',
      companionVoicePayload: { cerebrasAPIKey: 'master-value-must-not-appear' },
    }, transport, {
      allowBridgeAuthenticationFields: true,
      nowEpochMilliseconds: NOW,
    }),
    VoiceCredentialErrorCode.MASTER_API_KEY_FORBIDDEN,
    '/companionVoicePayload/cerebrasAPIKey',
    ['master-value-must-not-appear'],
  );
});

test('HTTP and WebSocket routes enforce the credential boundary before runtime allocation', async () => {
  const testRoot = await mkdtemp(join(tmpdir(), 'voiceclaw-credential-route-'));
  const configPath = join(testRoot, 'bridge.json');
  await writeFile(configPath, JSON.stringify({
    openAIAPIKey: 'outgoing-openai-master-value',
    cerebrasAPIKey: 'outgoing-cerebras-master-value',
    ChatGPTOAuthAccessToken: 'outgoing-access-value',
    ChatGPTOAuthRefreshToken: 'outgoing-refresh-value',
    ChatGPTOAuthAccountID: 'setup-account-id',
    tailscaleBaseURL: 'https://voiceclaw.example.ts.net',
    watchPublicBridgeURL: 'https://voice.example.test',
    openClawInstallPath: '/tmp/voiceclaw-openclaw',
    gatewayToken: 'setup-gateway-token',
    gatewayPassword: 'setup-gateway-password',
    openClawAgentName: 'julian',
    futureSetupField: {
      nested: ['preserve', 7, true],
    },
  }));
  process.env.VOICECLAW_OUTER_HF_TEST = '1';
  process.env.VOICECLAW_CONFIG_PATH = configPath;
  process.env.REALTIME_LOG_DIR = join(testRoot, 'logs');
  process.env.VOICECLAW_BRIDGE_TOKEN = 'credential-route-bridge-token';
  process.env.VOICECLAW_BRIDGE_PASSWORD = '';
  process.env.OPENCLAW_GATEWAY_PASSWORD = '';
  process.env.COMPANION_VOICE_HF_PREWARM = '0';
  process.env.COMPANION_VOICE_HF_KEEPHOT = '0';
  process.env.OPENCLAW_INSTALL_PATH = join(testRoot, 'missing-openclaw');
  process.env.OPENCLAW_CONFIG = join(testRoot, 'missing-openclaw.json');

  const { outerHFIntegration } = await import('../server/index.js');
  const { httpServer, wsPath } = outerHFIntegration;
  httpServer.listen(0, '127.0.0.1');
  await once(httpServer, 'listening');
  const address = httpServer.address();
  const origin = `http://127.0.0.1:${address.port}`;

  try {
    const rejectedHTTP = await fetch(`${origin}/realtime/cancel`, {
      method: 'POST',
      headers: {
        Authorization: 'Bearer credential-route-bridge-token',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        sessionToken: 'credential-route-session',
        refresh_token: 'incoming-refresh-value-must-not-appear',
      }),
    });
    assert.equal(rejectedHTTP.status, 400);
    const rejectedHTTPBody = await rejectedHTTP.json();
    assert.equal(
      rejectedHTTPBody.error.code,
      VoiceCredentialErrorCode.REFRESH_TOKEN_FORBIDDEN,
    );
    assert.equal(
      JSON.stringify(rejectedHTTPBody).includes('incoming-refresh-value-must-not-appear'),
      false,
    );

    const rejectedWrongContentType = await fetch(`${origin}/realtime/cancel`, {
      method: 'POST',
      headers: {
        Authorization: 'Bearer credential-route-bridge-token',
        'Content-Type': 'text/plain',
      },
      body: JSON.stringify({
        sessionToken: 'credential-route-session',
        cerebrasAPIKey: 'wrong-content-type-master-value-must-not-appear',
      }),
    });
    assert.equal(rejectedWrongContentType.status, 400);
    const rejectedWrongContentTypeBody = await rejectedWrongContentType.json();
    assert.equal(
      rejectedWrongContentTypeBody.error.code,
      VoiceCredentialErrorCode.MASTER_API_KEY_FORBIDDEN,
    );
    assert.equal(
      JSON.stringify(rejectedWrongContentTypeBody)
        .includes('wrong-content-type-master-value-must-not-appear'),
      false,
    );

    const issuedAt = Date.now();
    const acceptedHTTP = await fetch(`${origin}/realtime/cancel`, {
      method: 'POST',
      headers: {
        Authorization: 'Bearer credential-route-bridge-token',
        'Content-Type': 'application/json',
        Forwarded: 'for=203.0.113.7;proto=http',
      },
      body: JSON.stringify({
        sessionToken: 'credential-route-session',
        [VOICE_CREDENTIAL_DELEGATION_FIELD]: envelope({
          issuedAtEpochMilliseconds: issuedAt,
          expiresAtEpochMilliseconds: issuedAt + 60_000,
        }),
      }),
    });
    assert.equal(acceptedHTTP.status, 200);
    assert.equal((await acceptedHTTP.text()).includes(ACCESS_TOKEN), false);

    const setupResponse = await fetch(`${origin}/realtime/setup-payload`, {
      headers: { Authorization: 'Bearer credential-route-bridge-token' },
    });
    assert.equal(setupResponse.status, 200);
    assert.match(setupResponse.headers.get('cache-control') || '', /no-store/);
    const setupPayload = await setupResponse.json();
    assert.equal(setupPayload.OpenAIAPIKey, 'outgoing-openai-master-value');
    assert.equal(setupPayload.CerebrasAPIKey, 'outgoing-cerebras-master-value');
    assert.equal(setupPayload.ChatGPTOAuthAccessToken, 'outgoing-access-value');
    assert.equal(setupPayload.ChatGPTOAuthRefreshToken, 'outgoing-refresh-value');
    assert.equal(setupPayload.ChatGPTOAuthAccountID, 'setup-account-id');
    assert.equal(setupPayload.TailscaleBaseURL, 'https://voiceclaw.example.ts.net');
    assert.equal(setupPayload.WatchPublicBridgeURL, 'https://voice.example.test');
    assert.equal(setupPayload.OpenClawInstallPath, '/tmp/voiceclaw-openclaw');
    assert.equal(setupPayload.OpenClawGatewayToken, 'setup-gateway-token');
    assert.equal(setupPayload.OpenClawGatewayPassword, 'setup-gateway-password');
    assert.equal(setupPayload.OpenClawAgent, 'julian');
    assert.deepEqual(setupPayload.futureSetupField, {
      nested: ['preserve', 7, true],
    });

    const setupWithoutProviderKeys = await fetch(
      `${origin}/realtime/setup-payload?include_openai_key=0&include_cerebras_key=0`,
      { headers: { Authorization: 'Bearer credential-route-bridge-token' } },
    );
    assert.equal(setupWithoutProviderKeys.status, 200);
    const optedOutPayload = await setupWithoutProviderKeys.json();
    assert.equal(optedOutPayload.OpenAIAPIKey, '');
    assert.equal(optedOutPayload.CerebrasAPIKey, '');
    assert.equal('openAIAPIKey' in optedOutPayload, false);
    assert.equal('cerebrasAPIKey' in optedOutPayload, false);
    assert.equal(optedOutPayload.ChatGPTOAuthAccessToken, 'outgoing-access-value');
    assert.equal(optedOutPayload.WatchPublicBridgeURL, 'https://voice.example.test');
    assert.deepEqual(optedOutPayload.futureSetupField, {
      nested: ['preserve', 7, true],
    });

    const before = outerHFIntegration.credentialBoundaryRuntimeSnapshot();
    const events = [];
    const ws = new WebSocket(`ws://127.0.0.1:${address.port}${wsPath}`);
    ws.on('message', (data) => events.push(JSON.parse(String(data))));
    await once(ws, 'open');
    const closePromise = once(ws, 'close');
    ws.send(JSON.stringify({
      type: 'start_session',
      token: 'credential-route-bridge-token',
      companionVoice: true,
      companionVoicePayload: {
        brainMode: 'qwen3.5-0.8b',
        cerebrasAPIKey: 'ws-master-value-must-not-appear',
      },
    }));
    const [closeCode] = await closePromise;
    assert.equal(closeCode, 1008);
    const after = outerHFIntegration.credentialBoundaryRuntimeSnapshot();
    assert.deepEqual(after, before);
    assert.equal(events.some((event) => (
      event.code === VoiceCredentialErrorCode.MASTER_API_KEY_FORBIDDEN
    )), true);
    assert.equal(events.some((event) => event.status === 'authenticated'), false);
    assert.equal(events.some((event) => event.type === 'processing'), false);
    assert.equal(events.some((event) => event.status === 'preparing-hf-runtime'), false);
    assert.equal(JSON.stringify(events).includes('ws-master-value-must-not-appear'), false);
  } finally {
    await new Promise((resolve) => httpServer.close(resolve));
  }
});
