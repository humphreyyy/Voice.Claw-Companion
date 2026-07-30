import assert from 'node:assert/strict';
import test from 'node:test';

import {
  VoiceClawPromptContractError,
  assertPromptContractValueEquals,
  canonicalPromptContractJSON,
  parseVoiceClawPromptContractJSON,
  promptContractSHA256,
  validateVoiceClawPromptContract,
} from '../server/prompt-contract.js';

function realtimeContract(overrides = {}) {
  const prompt = 'You are the canonical iOS-authored VoiceClaw prompt.';
  const tools = [
    { type: 'function', name: 'wait_for_user', description: 'Wait.', parameters: {} },
    { type: 'function', name: 'openclaw_turn', description: 'Delegate.', parameters: {} },
  ];
  const base = {
    schemaVersion: 1,
    contractID: 'contract-test-1',
    issuer: {
      platform: 'ios',
      appVersion: '1.4.70',
      build: '202607300401',
    },
    engine: 'gpt-realtime-2',
    route: {
      mode: 'openclaw-bridge',
      agentID: 'julian',
      sessionToken: 'session-test-1',
    },
    authentication: {
      mode: 'openclaw-oauth',
      apiKeyFallbackAllowed: false,
    },
    capabilitySchemaVersion: 1,
    payload: {
      kind: 'openai-realtime-session',
      session: {
        type: 'realtime',
        instructions: prompt,
        tools,
      },
      prompt,
      initialItems: [],
      threadDeveloperInstructions: 'Preserve the exact iOS contract.',
      toolOwnership: {
        wait_for_user: 'iphone',
        openclaw_turn: 'companion',
      },
    },
    resultPolicy: {
      mode: 'model-from-function-output',
    },
  };
  return {
    ...base,
    ...overrides,
  };
}

function gptLiveContract() {
  const contract = realtimeContract();
  contract.engine = 'gpt-live';
  contract.authentication = {
    mode: 'codex-chatgpt-login',
    apiKeyFallbackAllowed: false,
  };
  contract.payload = {
    kind: 'codex-live-v3',
    session: {},
    brokerTools: [
      { name: 'gpt_live_answer_directly', description: 'Answer directly.' },
      { name: 'voiceclaw_send_route_task', description: 'Route work.' },
    ],
    prompt: 'Canonical GPT Live prompt.',
    initialItems: [
      { role: 'developer', text: 'Canonical startup context.' },
    ],
    threadDeveloperInstructions: 'Preserve the exact iOS contract.',
    toolOwnership: {
      gpt_live_answer_directly: 'iphone',
      voiceclaw_send_route_task: 'iphone',
    },
  };
  return contract;
}

test('accepts the exact canonical iOS Realtime prompt contract', () => {
  const contract = realtimeContract();
  const digest = promptContractSHA256(contract);
  const validated = validateVoiceClawPromptContract(contract, {
    expectedKind: 'openai-realtime-session',
    expectedSHA256: digest,
  });

  assert.equal(validated.contract, contract);
  assert.equal(validated.sha256, digest);
  assert.equal(validated.payload.prompt, contract.payload.prompt);
});

test('parses canonical JSON and rejects a mismatched digest', () => {
  const contract = realtimeContract();
  const parsed = parseVoiceClawPromptContractJSON(JSON.stringify(contract), {
    expectedKind: 'openai-realtime-session',
  });
  assert.equal(parsed.sha256, promptContractSHA256(contract));

  assert.throws(
    () => validateVoiceClawPromptContract(contract, {
      expectedSHA256: '0'.repeat(64),
    }),
    /digest does not match/i);
});

test('requires exact ownership coverage for every Realtime tool', () => {
  const contract = realtimeContract();
  delete contract.payload.toolOwnership.openclaw_turn;
  assert.throws(
    () => validateVoiceClawPromptContract(contract),
    /ownership must exactly cover/i);
});

test('requires exact ownership coverage for every GPT Live broker tool', () => {
  const contract = gptLiveContract();
  assert.doesNotThrow(() => validateVoiceClawPromptContract(contract, {
    expectedKind: 'codex-live-v3',
  }));

  delete contract.payload.toolOwnership.voiceclaw_send_route_task;
  assert.throws(
    () => validateVoiceClawPromptContract(contract, {
      expectedKind: 'codex-live-v3',
    }),
    /ownership must exactly cover/i);
});

test('matches the Swift canonical JSON golden vector without escaped slashes', () => {
  const object = {
    url: 'https://example.com/v1/realtime/calls',
    nested: {
      z: 2,
      a: 'slash/value',
    },
    array: [{
      z: 'https://voiceclawrealtime.com/a/b',
      a: true,
    }],
  };
  const expected = '{"array":[{"a":true,"z":"https://voiceclawrealtime.com/a/b"}],"nested":{"a":"slash/value","z":2},"url":"https://example.com/v1/realtime/calls"}';
  assert.equal(canonicalPromptContractJSON(object), expected);
  assert.equal(
    promptContractSHA256(object),
    'b9298e0068ed8133397ccf43aaffe4e2f9a1b5136ddc47e678f30bef90512b02',
  );
});

test('rejects numbers that cannot be canonicalized identically by Swift and JavaScript', () => {
  assert.throws(
    () => canonicalPromptContractJSON({ fraction: 0.1 }),
    /safe integers/i);
  assert.throws(
    () => canonicalPromptContractJSON({ negativeZero: -0 }),
    /safe integers/i);
  assert.throws(
    () => canonicalPromptContractJSON({ unsafeInteger: Number.MAX_SAFE_INTEGER + 1 }),
    /safe integers/i);
  assert.equal(
    canonicalPromptContractJSON({ safeInteger: Number.MAX_SAFE_INTEGER }),
    `{"safeInteger":${Number.MAX_SAFE_INTEGER}}`);
});

test('rejects credentials anywhere in a prompt contract', () => {
  const contract = realtimeContract({
    extension: {
      accessToken: 'must-not-cross-the-prompt-boundary',
    },
  });
  assert.throws(
    () => validateVoiceClawPromptContract(contract),
    /must not contain credentials/i);
});

test('reports an upgrade-required error for an unsupported schema', () => {
  const contract = realtimeContract({ schemaVersion: 2 });
  assert.throws(
    () => validateVoiceClawPromptContract(contract),
    (error) => {
      assert.ok(error instanceof VoiceClawPromptContractError);
      assert.equal(error.statusCode, 426);
      assert.equal(error.code, 'VOICECLAW_PROMPT_CONTRACT_UPGRADE_REQUIRED');
      return true;
    });
});

test('requires the request session and prompt to equal the iOS contract', () => {
  const contract = realtimeContract();
  assert.doesNotThrow(() => assertPromptContractValueEquals(
    contract.payload.session,
    contract.payload.session,
    'Realtime session'));
  assert.throws(
    () => assertPromptContractValueEquals(
      { ...contract.payload.session, instructions: 'stale Companion prompt' },
      contract.payload.session,
      'Realtime session'),
    /does not match the canonical iOS prompt contract/i);
});
