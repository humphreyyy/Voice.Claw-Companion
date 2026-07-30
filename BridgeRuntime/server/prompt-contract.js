import { createHash } from 'node:crypto';

export const VOICECLAW_PROMPT_CONTRACT_SCHEMA_VERSION = 1;
export const VOICECLAW_PROMPT_CONTRACT_MAX_BYTES = 2_000_000;

const FORBIDDEN_CREDENTIAL_KEYS = new Set([
  'apikey',
  'authorization',
  'bearer',
  'password',
  'accesstoken',
  'refreshtoken',
  'clientsecret',
  'oauthcredential',
]);

export class VoiceClawPromptContractError extends Error {
  constructor(message, {
    code = 'VOICECLAW_PROMPT_CONTRACT_INVALID',
    statusCode = 400,
  } = {}) {
    super(message);
    this.name = 'VoiceClawPromptContractError';
    this.code = code;
    this.statusCode = statusCode;
  }
}

function fail(message, options) {
  throw new VoiceClawPromptContractError(message, options);
}

function isObject(value) {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function assertNoCredentials(value, path = 'contract') {
  if (Array.isArray(value)) {
    value.forEach((item, index) => assertNoCredentials(item, `${path}[${index}]`));
    return;
  }
  if (!isObject(value)) return;
  for (const [key, item] of Object.entries(value)) {
    if (FORBIDDEN_CREDENTIAL_KEYS.has(key.toLowerCase())) {
      fail(`Prompt contract must not contain credentials (${path}.${key}).`);
    }
    assertNoCredentials(item, `${path}.${key}`);
  }
}

function canonicalValue(value) {
  if (Array.isArray(value)) return value.map(canonicalValue);
  if (!isObject(value)) return value;
  return Object.fromEntries(
    Object.keys(value)
      .sort()
      .map((key) => [key, canonicalValue(value[key])]),
  );
}

function assertCanonicalNumbers(value, path = '$') {
  if (typeof value === 'number') {
    if (!Number.isSafeInteger(value) || Object.is(value, -0)) {
      fail(`Prompt contract numbers must be safe integers (${path}).`);
    }
    return;
  }
  if (Array.isArray(value)) {
    value.forEach((item, index) => assertCanonicalNumbers(item, `${path}[${index}]`));
    return;
  }
  if (!isObject(value)) return;
  for (const [key, item] of Object.entries(value)) {
    assertCanonicalNumbers(item, `${path}.${key}`);
  }
}

export function canonicalPromptContractJSON(value) {
  assertCanonicalNumbers(value);
  return JSON.stringify(canonicalValue(value));
}

export function promptContractSHA256(value) {
  return createHash('sha256')
    .update(canonicalPromptContractJSON(value), 'utf8')
    .digest('hex');
}

function assertText(value, label, { required = true, maximum = 1_000_000 } = {}) {
  if (typeof value !== 'string') fail(`${label} must be a string.`);
  if (required && !value.trim()) fail(`${label} is required.`);
  if (value.length > maximum) fail(`${label} is too large.`);
}

function assertToolOwnership(payload) {
  if (!isObject(payload.toolOwnership)) {
    fail('Prompt contract payload.toolOwnership must be an object.');
  }
  for (const [name, owner] of Object.entries(payload.toolOwnership)) {
    assertText(name, 'Prompt contract tool name', { maximum: 256 });
    if (!['iphone', 'companion'].includes(owner)) {
      fail(`Prompt contract tool owner for ${name} must be iphone or companion.`);
    }
  }

  const tools = payload.kind === 'codex-live-v3'
    ? payload.brokerTools
    : payload.session?.tools;
  if (!Array.isArray(tools) || !tools.length) {
    fail(
      payload.kind === 'codex-live-v3'
        ? 'Prompt contract GPT Live brokerTools must contain its exact broker tool list.'
        : 'Prompt contract Realtime session must contain its exact tool list.');
  }
  const names = tools.map((tool) => String(tool?.name || '').trim()).filter(Boolean);
  if (names.length !== tools.length || new Set(names).size !== names.length) {
    fail('Prompt contract session tools must have unique non-empty names.');
  }
  const ownershipNames = Object.keys(payload.toolOwnership).sort();
  if (canonicalPromptContractJSON(names.sort()) !== canonicalPromptContractJSON(ownershipNames)) {
    fail('Prompt contract tool ownership must exactly cover the supplied session tools.');
  }
}

function assertInitialItems(value) {
  if (!Array.isArray(value) || value.length > 128) {
    fail('Prompt contract payload.initialItems must contain at most 128 items.');
  }
  for (const [index, item] of value.entries()) {
    if (!isObject(item)) fail(`Prompt contract initialItems[${index}] must be an object.`);
    if (!['user', 'assistant', 'developer'].includes(String(item.role || '').toLowerCase())) {
      fail(`Prompt contract initialItems[${index}].role is invalid.`);
    }
    assertText(item.text, `Prompt contract initialItems[${index}].text`);
  }
}

export function validateVoiceClawPromptContract(value, {
  expectedKind = '',
  expectedSHA256 = '',
} = {}) {
  if (!isObject(value)) fail('Prompt contract must be a JSON object.');
  const canonicalJSON = canonicalPromptContractJSON(value);
  if (Buffer.byteLength(canonicalJSON, 'utf8') > VOICECLAW_PROMPT_CONTRACT_MAX_BYTES) {
    fail('Prompt contract is too large.');
  }
  if (value.schemaVersion !== VOICECLAW_PROMPT_CONTRACT_SCHEMA_VERSION) {
    fail(
      `Unsupported prompt contract schema ${String(value.schemaVersion ?? '(missing)')}.`,
      { code: 'VOICECLAW_PROMPT_CONTRACT_UPGRADE_REQUIRED', statusCode: 426 },
    );
  }
  assertText(value.contractID, 'Prompt contract contractID', { maximum: 256 });
  assertText(value.engine, 'Prompt contract engine', { maximum: 128 });
  if (!isObject(value.issuer) || !isObject(value.route) || !isObject(value.payload)) {
    fail('Prompt contract issuer, route, and payload are required objects.');
  }
  if (!isObject(value.authentication)) {
    fail('Prompt contract authentication policy is required.');
  }
  assertText(value.issuer.platform, 'Prompt contract issuer.platform', { maximum: 64 });
  assertText(value.route.mode, 'Prompt contract route.mode', { maximum: 128 });
  assertText(value.route.sessionToken, 'Prompt contract route.sessionToken', { maximum: 256 });
  assertText(value.authentication.mode, 'Prompt contract authentication.mode', {
    maximum: 128,
  });
  if (typeof value.authentication.apiKeyFallbackAllowed !== 'boolean') {
    fail('Prompt contract authentication.apiKeyFallbackAllowed must be a boolean.');
  }
  if (!Number.isInteger(value.capabilitySchemaVersion) || value.capabilitySchemaVersion < 1) {
    fail('Prompt contract capabilitySchemaVersion must be a positive integer.');
  }

  const payload = value.payload;
  assertText(payload.kind, 'Prompt contract payload.kind', { maximum: 128 });
  if (expectedKind && payload.kind !== expectedKind) {
    fail(`Prompt contract payload kind must be ${expectedKind}.`);
  }
  assertText(payload.prompt, 'Prompt contract payload.prompt');
  assertText(
    payload.threadDeveloperInstructions,
    'Prompt contract payload.threadDeveloperInstructions');
  assertInitialItems(payload.initialItems);
  if (!isObject(payload.session)) {
    fail('Prompt contract payload.session must be an object.');
  }
  if (payload.kind === 'openai-realtime-session') {
    if (payload.session.instructions !== payload.prompt) {
      fail('Prompt contract realtime session instructions do not match its canonical prompt.');
    }
    if (!Array.isArray(payload.session.tools)) {
      fail('Prompt contract realtime session must include its exact tool list.');
    }
  } else if (payload.kind === 'codex-live-v3' && !Array.isArray(payload.brokerTools)) {
    fail('Prompt contract GPT Live payload must include its exact brokerTools list.');
  }
  assertToolOwnership(payload);
  assertNoCredentials(value);

  const sha256 = createHash('sha256').update(canonicalJSON, 'utf8').digest('hex');
  const expected = String(expectedSHA256 || '').trim().toLowerCase();
  if (expected && expected !== sha256) {
    fail('Prompt contract digest does not match the request.');
  }
  return {
    contract: value,
    canonicalJSON,
    sha256,
    payload,
  };
}

export function parseVoiceClawPromptContractJSON(text, options = {}) {
  let value;
  try {
    value = JSON.parse(String(text || ''));
  } catch {
    fail('Prompt contract is not valid JSON.');
  }
  return validateVoiceClawPromptContract(value, options);
}

export function assertPromptContractValueEquals(actual, expected, label) {
  if (canonicalPromptContractJSON(actual) !== canonicalPromptContractJSON(expected)) {
    fail(`${label} does not match the canonical iOS prompt contract.`);
  }
}
