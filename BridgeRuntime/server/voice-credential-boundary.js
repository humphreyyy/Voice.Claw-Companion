export const VOICE_CREDENTIAL_DELEGATION_SCHEMA_VERSION = 1;
export const VOICE_CREDENTIAL_DELEGATION_KIND = 'access_token_delegation';
export const VOICE_CREDENTIAL_DELEGATION_FIELD = 'credentialDelegation';
export const VOICE_CREDENTIAL_TRANSPORT_PRECONDITION = 'tls_or_true_loopback';
export const VOICE_CREDENTIAL_MAX_TTL_MS = 5 * 60 * 1000;
export const VOICE_CREDENTIAL_MAX_CLOCK_SKEW_MS = 30 * 1000;

export const VoiceCredentialErrorCode = Object.freeze({
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

export const VoiceCredentialSecretCategory = Object.freeze({
  OAUTH_REFRESH_TOKEN: 'oauth_refresh_token',
  PROVIDER_MASTER_API_KEY: 'provider_master_api_key',
  ACCESS_TOKEN: 'access_token',
  OTHER_SECRET: 'other_secret',
});

const ERROR_MESSAGES = Object.freeze({
  [VoiceCredentialErrorCode.INSECURE_TRANSPORT]:
    'Credential delegation requires TLS or a true loopback transport.',
  [VoiceCredentialErrorCode.REFRESH_TOKEN_FORBIDDEN]:
    'OAuth refresh tokens are forbidden in Companion control payloads.',
  [VoiceCredentialErrorCode.MASTER_API_KEY_FORBIDDEN]:
    'Provider master API keys are forbidden in Companion control payloads.',
  [VoiceCredentialErrorCode.ACCESS_TOKEN_OUTSIDE_DELEGATION]:
    'Access tokens are allowed only in a validated short-lived delegation.',
  [VoiceCredentialErrorCode.UNEXPECTED_SECRET_FIELD]:
    'An unexpected secret field was found in a Companion control payload.',
  [VoiceCredentialErrorCode.INVALID_ENVELOPE]:
    'The credential delegation envelope is malformed.',
  [VoiceCredentialErrorCode.UNSUPPORTED_SCHEMA]:
    'The credential delegation schema version is unsupported.',
  [VoiceCredentialErrorCode.INVALID_KIND]:
    'The credential delegation kind is unsupported.',
  [VoiceCredentialErrorCode.INVALID_TRANSPORT_PRECONDITION]:
    'The credential delegation transport precondition is invalid.',
  [VoiceCredentialErrorCode.MISSING_FIELD]:
    'The credential delegation is missing a required field.',
  [VoiceCredentialErrorCode.INVALID_FIELD]:
    'A credential delegation field is invalid.',
  [VoiceCredentialErrorCode.INVALID_SCOPE]:
    'The credential delegation contains a malformed scope.',
  [VoiceCredentialErrorCode.EXPIRED]:
    'The credential delegation has expired.',
  [VoiceCredentialErrorCode.TTL_EXCEEDED]:
    'The credential delegation lifetime exceeds the permitted maximum.',
  [VoiceCredentialErrorCode.ISSUED_AT_IN_FUTURE]:
    'The credential delegation issue time is unexpectedly far in the future.',
  [VoiceCredentialErrorCode.UNEXPECTED_FIELD]:
    'The credential delegation contains an unexpected field.',
});

const REQUIRED_ENVELOPE_FIELDS = Object.freeze([
  'schemaVersion',
  'kind',
  'transportSecurity',
  'accessToken',
  'issuedAtEpochMilliseconds',
  'expiresAtEpochMilliseconds',
  'accountID',
  'provider',
  'scopes',
]);
const ALLOWED_ENVELOPE_FIELDS = new Set(REQUIRED_ENVELOPE_FIELDS);
const VALIDATED_DELEGATIONS = new WeakSet();
const CONTROL_PAYLOAD_DELEGATIONS = new WeakMap();
const BRIDGE_AUTH_SECRET_PATHS = new Set([
  '/bearerToken',
  '/gatewayPassword',
  '/gatewayToken',
  '/password',
  '/sessionCode',
  '/token',
]);

export class VoiceCredentialBoundaryError extends Error {
  constructor(code, path = null) {
    const baseMessage = ERROR_MESSAGES[code] || ERROR_MESSAGES[VoiceCredentialErrorCode.INVALID_ENVELOPE];
    super(path ? `${baseMessage} Field path: ${path}.` : baseMessage);
    this.name = 'VoiceCredentialBoundaryError';
    this.code = code;
    if (path) this.path = path;
  }
}

export function sanitizeVoiceControlPayload(payload) {
  if (!isDictionary(payload)) {
    throw boundaryError(VoiceCredentialErrorCode.INVALID_ENVELOPE);
  }
  const removals = [];
  const sanitized = sanitizeValue(payload, '', removals, new Set());
  removals.sort(compareRemovals);
  return { payload: sanitized, removals };
}

export function assertVoiceControlPayloadCredentialSafe(payload) {
  const { removals } = sanitizeVoiceControlPayload(payload);
  const refreshToken = removals.find(
    (removal) => removal.category === VoiceCredentialSecretCategory.OAUTH_REFRESH_TOKEN,
  );
  if (refreshToken) {
    throw boundaryError(VoiceCredentialErrorCode.REFRESH_TOKEN_FORBIDDEN, refreshToken.path);
  }
  const masterAPIKey = removals.find(
    (removal) => removal.category === VoiceCredentialSecretCategory.PROVIDER_MASTER_API_KEY,
  );
  if (masterAPIKey) {
    throw boundaryError(VoiceCredentialErrorCode.MASTER_API_KEY_FORBIDDEN, masterAPIKey.path);
  }
  const accessToken = removals.find(
    (removal) => removal.category === VoiceCredentialSecretCategory.ACCESS_TOKEN,
  );
  if (accessToken) {
    throw boundaryError(
      VoiceCredentialErrorCode.ACCESS_TOKEN_OUTSIDE_DELEGATION,
      accessToken.path,
    );
  }
  if (removals[0]) {
    throw boundaryError(VoiceCredentialErrorCode.UNEXPECTED_SECRET_FIELD, removals[0].path);
  }
  return payload;
}

/**
 * Applies the credential boundary to one parsed HTTP or WebSocket control object.
 * A delegation is accepted only at the top-level `credentialDelegation` field and
 * is deliberately removed from the ordinary payload returned to route handlers.
 */
export function enforceVoiceCredentialBoundaryOnControlPayload(
  payload,
  transport,
  {
    allowBridgeAuthenticationFields = false,
    nowEpochMilliseconds = Date.now(),
  } = {},
) {
  const { ordinaryPayload, delegationEnvelope, hasDelegation } = splitControlPayload(payload);
  const sanitized = sanitizeVoiceControlPayload(ordinaryPayload);

  const refreshToken = sanitized.removals.find(
    (removal) => removal.category === VoiceCredentialSecretCategory.OAUTH_REFRESH_TOKEN,
  );
  if (refreshToken) {
    throw boundaryError(VoiceCredentialErrorCode.REFRESH_TOKEN_FORBIDDEN, refreshToken.path);
  }
  const masterAPIKey = sanitized.removals.find(
    (removal) => removal.category === VoiceCredentialSecretCategory.PROVIDER_MASTER_API_KEY,
  );
  if (masterAPIKey) {
    throw boundaryError(VoiceCredentialErrorCode.MASTER_API_KEY_FORBIDDEN, masterAPIKey.path);
  }

  const disallowedRemoval = sanitized.removals.find((removal) => !(
    allowBridgeAuthenticationFields && BRIDGE_AUTH_SECRET_PATHS.has(removal.path)
  ));
  if (disallowedRemoval) {
    const code = disallowedRemoval.category === VoiceCredentialSecretCategory.ACCESS_TOKEN
      ? VoiceCredentialErrorCode.ACCESS_TOKEN_OUTSIDE_DELEGATION
      : VoiceCredentialErrorCode.UNEXPECTED_SECRET_FIELD;
    throw boundaryError(code, disallowedRemoval.path);
  }

  const credentialDelegation = hasDelegation
    ? validateVoiceAccessTokenDelegation(
        delegationEnvelope,
        transport,
        { nowEpochMilliseconds },
      )
    : null;
  if (credentialDelegation) {
    bindValidatedVoiceAccessTokenDelegation(sanitized.payload, credentialDelegation);
  }
  return {
    payload: sanitized.payload,
    credentialDelegation,
    removals: sanitized.removals,
  };
}

export function bindValidatedVoiceAccessTokenDelegation(payload, credentialDelegation) {
  if (!isDictionary(payload) || !VALIDATED_DELEGATIONS.has(credentialDelegation)) {
    throw boundaryError(VoiceCredentialErrorCode.INVALID_ENVELOPE);
  }
  CONTROL_PAYLOAD_DELEGATIONS.set(payload, credentialDelegation);
  return payload;
}

export function validatedVoiceAccessTokenDelegationForPayload(
  payload,
  { nowEpochMilliseconds = Date.now() } = {},
) {
  if (payload === null || (typeof payload !== 'object' && typeof payload !== 'function')) return null;
  const credentialDelegation = CONTROL_PAYLOAD_DELEGATIONS.get(payload);
  if (!credentialDelegation) return null;
  assertValidatedVoiceAccessTokenDelegation(credentialDelegation, nowEpochMilliseconds);
  return credentialDelegation;
}

/**
 * `protocol` must come from the actual listener and `peerAddress` from the socket.
 * Do not derive either value from Host, Forwarded, X-Forwarded-Proto, or payload fields.
 */
export function isConfidentialVoiceCredentialTransport(transport) {
  if (!isDictionary(transport)) return false;
  const protocol = normalizedProtocol(transport.protocol);
  if (protocol === 'https:' || protocol === 'wss:') return true;
  if (protocol !== 'http:' && protocol !== 'ws:') return false;
  return isTrueLoopbackVoiceCredentialPeerAddress(transport.peerAddress);
}

/**
 * Derives transport facts only from Node's accepted socket. Forwarding and Host
 * headers are intentionally ignored because they are controlled by the peer.
 */
export function voiceCredentialTransportFromNodeRequest(request, { webSocket = false } = {}) {
  const socket = request?.socket;
  const encrypted = socket?.encrypted === true;
  return Object.freeze({
    protocol: webSocket
      ? (encrypted ? 'wss:' : 'ws:')
      : (encrypted ? 'https:' : 'http:'),
    peerAddress: typeof socket?.remoteAddress === 'string' ? socket.remoteAddress : '',
  });
}

export function isTrueLoopbackVoiceCredentialPeerAddress(value) {
  if (typeof value !== 'string' || value !== value.trim() || !value) return false;
  let address = value.toLowerCase();
  if (address.startsWith('[') && address.endsWith(']')) {
    address = address.slice(1, -1);
  }
  if (address === '::1') return true;
  if (address.startsWith('::ffff:')) address = address.slice('::ffff:'.length);

  const octets = address.split('.');
  if (octets.length !== 4) return false;
  const numbers = [];
  for (const octet of octets) {
    if (!/^(0|[1-9][0-9]{0,2})$/.test(octet)) return false;
    const number = Number(octet);
    if (number > 255) return false;
    numbers.push(number);
  }
  return numbers[0] === 127;
}

export function validateVoiceAccessTokenDelegation(
  envelope,
  transport,
  { nowEpochMilliseconds = Date.now() } = {},
) {
  if (!isDictionary(envelope)) {
    throw boundaryError(VoiceCredentialErrorCode.INVALID_ENVELOPE);
  }

  const { removals } = sanitizeVoiceControlPayload(envelope);
  const refreshToken = removals.find(
    (removal) => removal.category === VoiceCredentialSecretCategory.OAUTH_REFRESH_TOKEN,
  );
  if (refreshToken) {
    throw boundaryError(VoiceCredentialErrorCode.REFRESH_TOKEN_FORBIDDEN, refreshToken.path);
  }
  const masterAPIKey = removals.find(
    (removal) => removal.category === VoiceCredentialSecretCategory.PROVIDER_MASTER_API_KEY,
  );
  if (masterAPIKey) {
    throw boundaryError(VoiceCredentialErrorCode.MASTER_API_KEY_FORBIDDEN, masterAPIKey.path);
  }
  const unexpectedAccessToken = removals.find((removal) => !(
    removal.category === VoiceCredentialSecretCategory.ACCESS_TOKEN
      && removal.path === '/accessToken'
      && removal.field === 'accessToken'
  ));
  if (unexpectedAccessToken) {
    const code = unexpectedAccessToken.category === VoiceCredentialSecretCategory.ACCESS_TOKEN
      ? VoiceCredentialErrorCode.ACCESS_TOKEN_OUTSIDE_DELEGATION
      : VoiceCredentialErrorCode.UNEXPECTED_SECRET_FIELD;
    throw boundaryError(code, unexpectedAccessToken.path);
  }

  for (const field of REQUIRED_ENVELOPE_FIELDS) {
    if (!Object.hasOwn(envelope, field)) {
      throw boundaryError(VoiceCredentialErrorCode.MISSING_FIELD, jsonPointer('', field));
    }
  }
  const unexpectedField = Object.keys(envelope)
    .filter((field) => !ALLOWED_ENVELOPE_FIELDS.has(field))
    .sort(compareStrings)[0];
  if (unexpectedField) {
    throw boundaryError(
      VoiceCredentialErrorCode.UNEXPECTED_FIELD,
      jsonPointer('', unexpectedField),
    );
  }

  if (!Number.isSafeInteger(envelope.schemaVersion)) {
    throw boundaryError(VoiceCredentialErrorCode.INVALID_FIELD, '/schemaVersion');
  }
  if (envelope.schemaVersion !== VOICE_CREDENTIAL_DELEGATION_SCHEMA_VERSION) {
    throw boundaryError(VoiceCredentialErrorCode.UNSUPPORTED_SCHEMA, '/schemaVersion');
  }
  if (envelope.kind !== VOICE_CREDENTIAL_DELEGATION_KIND) {
    throw boundaryError(VoiceCredentialErrorCode.INVALID_KIND, '/kind');
  }
  if (envelope.transportSecurity !== VOICE_CREDENTIAL_TRANSPORT_PRECONDITION) {
    throw boundaryError(
      VoiceCredentialErrorCode.INVALID_TRANSPORT_PRECONDITION,
      '/transportSecurity',
    );
  }
  if (!isConfidentialVoiceCredentialTransport(transport)) {
    throw boundaryError(VoiceCredentialErrorCode.INSECURE_TRANSPORT);
  }

  if (!isVisibleASCII(envelope.accessToken, 16_384)) {
    throw boundaryError(VoiceCredentialErrorCode.INVALID_FIELD, '/accessToken');
  }
  if (!isVisibleASCII(envelope.accountID, 256)) {
    throw boundaryError(VoiceCredentialErrorCode.INVALID_FIELD, '/accountID');
  }
  if (typeof envelope.provider !== 'string'
    || !/^[a-z0-9][a-z0-9._-]{0,63}$/.test(envelope.provider)) {
    throw boundaryError(VoiceCredentialErrorCode.INVALID_FIELD, '/provider');
  }
  const scopes = validatedScopes(envelope.scopes);

  validateDelegationLifetime(envelope, nowEpochMilliseconds);

  const validated = Object.freeze({
    schemaVersion: envelope.schemaVersion,
    kind: envelope.kind,
    transportSecurity: envelope.transportSecurity,
    accessToken: envelope.accessToken,
    issuedAtEpochMilliseconds: envelope.issuedAtEpochMilliseconds,
    expiresAtEpochMilliseconds: envelope.expiresAtEpochMilliseconds,
    accountID: envelope.accountID,
    provider: envelope.provider,
    scopes: Object.freeze(scopes),
  });
  VALIDATED_DELEGATIONS.add(validated);
  return validated;
}

export function accessTokenFromValidatedVoiceAccessTokenDelegation(
  credentialDelegation,
  { nowEpochMilliseconds = Date.now() } = {},
) {
  assertValidatedVoiceAccessTokenDelegation(credentialDelegation, nowEpochMilliseconds);
  return credentialDelegation.accessToken;
}

function splitControlPayload(payload) {
  if (!isDictionary(payload)) {
    throw boundaryError(VoiceCredentialErrorCode.INVALID_ENVELOPE);
  }
  const ordinaryPayload = {};
  let delegationEnvelope;
  let hasDelegation = false;
  for (const field of Reflect.ownKeys(payload)) {
    if (typeof field !== 'string') {
      throw boundaryError(VoiceCredentialErrorCode.INVALID_ENVELOPE, '/');
    }
    const path = jsonPointer('', field);
    const descriptor = Object.getOwnPropertyDescriptor(payload, field);
    if (!descriptor || !descriptor.enumerable || !Object.hasOwn(descriptor, 'value')) {
      throw boundaryError(VoiceCredentialErrorCode.INVALID_ENVELOPE, path);
    }
    if (field === VOICE_CREDENTIAL_DELEGATION_FIELD) {
      hasDelegation = true;
      delegationEnvelope = descriptor.value;
      continue;
    }
    Object.defineProperty(ordinaryPayload, field, {
      configurable: true,
      enumerable: true,
      writable: true,
      value: descriptor.value,
    });
  }
  return { ordinaryPayload, delegationEnvelope, hasDelegation };
}

function assertValidatedVoiceAccessTokenDelegation(credentialDelegation, nowEpochMilliseconds) {
  if (!credentialDelegation
    || typeof credentialDelegation !== 'object'
    || !VALIDATED_DELEGATIONS.has(credentialDelegation)) {
    throw boundaryError(VoiceCredentialErrorCode.INVALID_ENVELOPE);
  }
  validateDelegationLifetime(credentialDelegation, nowEpochMilliseconds);
}

function validateDelegationLifetime(envelope, nowEpochMilliseconds) {
  if (!Number.isSafeInteger(nowEpochMilliseconds) || nowEpochMilliseconds < 0) {
    throw boundaryError(VoiceCredentialErrorCode.INVALID_FIELD, '/nowEpochMilliseconds');
  }
  if (!Number.isSafeInteger(envelope.issuedAtEpochMilliseconds)
    || envelope.issuedAtEpochMilliseconds < 0) {
    throw boundaryError(
      VoiceCredentialErrorCode.INVALID_FIELD,
      '/issuedAtEpochMilliseconds',
    );
  }
  if (!Number.isSafeInteger(envelope.expiresAtEpochMilliseconds)
    || envelope.expiresAtEpochMilliseconds < 0) {
    throw boundaryError(
      VoiceCredentialErrorCode.INVALID_FIELD,
      '/expiresAtEpochMilliseconds',
    );
  }
  if (envelope.expiresAtEpochMilliseconds <= nowEpochMilliseconds) {
    throw boundaryError(VoiceCredentialErrorCode.EXPIRED, '/expiresAtEpochMilliseconds');
  }
  if (envelope.expiresAtEpochMilliseconds <= envelope.issuedAtEpochMilliseconds) {
    throw boundaryError(VoiceCredentialErrorCode.INVALID_FIELD, '/expiresAtEpochMilliseconds');
  }
  const latestPermittedIssueTime = Math.min(
    Number.MAX_SAFE_INTEGER,
    nowEpochMilliseconds + VOICE_CREDENTIAL_MAX_CLOCK_SKEW_MS,
  );
  if (envelope.issuedAtEpochMilliseconds > latestPermittedIssueTime) {
    throw boundaryError(
      VoiceCredentialErrorCode.ISSUED_AT_IN_FUTURE,
      '/issuedAtEpochMilliseconds',
    );
  }
  if (envelope.expiresAtEpochMilliseconds - envelope.issuedAtEpochMilliseconds
    > VOICE_CREDENTIAL_MAX_TTL_MS) {
    throw boundaryError(VoiceCredentialErrorCode.TTL_EXCEEDED, '/expiresAtEpochMilliseconds');
  }
}

function validatedScopes(value) {
  if (!Array.isArray(value) || value.length < 1 || value.length > 32) {
    throw boundaryError(VoiceCredentialErrorCode.INVALID_SCOPE, '/scopes');
  }
  const seen = new Set();
  for (let index = 0; index < value.length; index += 1) {
    const scope = value[index];
    if (typeof scope !== 'string'
      || !/^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$/.test(scope)) {
      throw boundaryError(VoiceCredentialErrorCode.INVALID_SCOPE, `/scopes/${index}`);
    }
    if (seen.has(scope)) {
      throw boundaryError(VoiceCredentialErrorCode.INVALID_SCOPE, '/scopes');
    }
    seen.add(scope);
  }
  return [...value].sort(compareStrings);
}

function sanitizeValue(value, path, removals, ancestors) {
  if (Array.isArray(value)) {
    rejectCycle(value, path, ancestors);
    const sanitized = value.map((child, index) => sanitizeValue(
      child,
      jsonPointer(path, String(index)),
      removals,
      ancestors,
    ));
    ancestors.delete(value);
    return sanitized;
  }
  if (!isDictionary(value)) {
    if (value === null || typeof value === 'string' || typeof value === 'boolean') return value;
    if (typeof value === 'number' && Number.isFinite(value)) return value;
    throw boundaryError(VoiceCredentialErrorCode.INVALID_ENVELOPE, path || '/');
  }

  rejectCycle(value, path, ancestors);
  const sanitized = {};
  for (const field of Object.keys(value).sort(compareStrings)) {
    const childPath = jsonPointer(path, field);
    const descriptor = Object.getOwnPropertyDescriptor(value, field);
    if (!descriptor || !Object.hasOwn(descriptor, 'value')) {
      throw boundaryError(VoiceCredentialErrorCode.INVALID_ENVELOPE, childPath);
    }
    const category = secretCategory(field, descriptor.value);
    if (category) {
      removals.push({ path: childPath, field, category });
      continue;
    }
    Object.defineProperty(sanitized, field, {
      configurable: true,
      enumerable: true,
      writable: true,
      value: sanitizeValue(descriptor.value, childPath, removals, ancestors),
    });
  }
  ancestors.delete(value);
  return sanitized;
}

function rejectCycle(value, path, ancestors) {
  if (ancestors.has(value)) {
    throw boundaryError(VoiceCredentialErrorCode.INVALID_ENVELOPE, path || '/');
  }
  ancestors.add(value);
}

function secretCategory(field, value) {
  const normalized = normalizedFieldName(field);
  if (!normalized) return null;
  if (isNonSecretAPIKeyIndicator(normalized)) {
    return typeof value === 'boolean'
      ? null
      : VoiceCredentialSecretCategory.PROVIDER_MASTER_API_KEY;
  }
  if (normalized === 'refreshtoken' || normalized.endsWith('refreshtoken')) {
    return VoiceCredentialSecretCategory.OAUTH_REFRESH_TOKEN;
  }
  if (normalized === 'apikey'
    || normalized.endsWith('apikey')
    || normalized === 'apitoken'
    || normalized.endsWith('apitoken')
    || normalized === 'masterkey'
    || normalized.endsWith('masterkey')) {
    return VoiceCredentialSecretCategory.PROVIDER_MASTER_API_KEY;
  }
  if (normalized === 'token'
    || normalized.endsWith('accesstoken')
    || normalized.endsWith('idtoken')
    || normalized.endsWith('bearertoken')
    || normalized.endsWith('gatewaytoken')
    || normalized.endsWith('bridgetoken')
    || normalized.endsWith('authtoken')
    || normalized.endsWith('oauthtoken')) {
    return VoiceCredentialSecretCategory.ACCESS_TOKEN;
  }
  if (normalized === 'authorization'
    || normalized.endsWith('authorizationheader')
    || normalized === 'proxyauthorization'
    || normalized === 'cookie'
    || normalized === 'setcookie'
    || normalized === 'password'
    || normalized.endsWith('password')
    || normalized === 'privatekey'
    || normalized.endsWith('privatekey')
    || normalized === 'secret'
    || normalized.endsWith('secret')
    || normalized === 'sessioncode') {
    return VoiceCredentialSecretCategory.OTHER_SECRET;
  }
  return null;
}

function isNonSecretAPIKeyIndicator(normalized) {
  return normalized.includes('fallbacktoapikey')
    || (normalized.startsWith('has') && normalized.endsWith('apikey'))
    || normalized === 'useapikey'
    || normalized === 'usesapikey'
    || normalized === 'allowapikey'
    || normalized === 'enableapikey'
    || normalized === 'apikeyenabled'
    || normalized.endsWith('apikeyconfigured')
    || normalized.endsWith('apikeypresent')
    || normalized.endsWith('apikeyavailable');
}

function normalizedFieldName(field) {
  return String(field).toLowerCase().replace(/[^a-z0-9]/g, '');
}

function normalizedProtocol(value) {
  if (typeof value !== 'string' || value !== value.trim()) return '';
  const protocol = value.toLowerCase();
  return protocol.endsWith(':') ? protocol : `${protocol}:`;
}

function isVisibleASCII(value, maximumLength) {
  return typeof value === 'string'
    && value.length >= 1
    && value.length <= maximumLength
    && /^[\x21-\x7e]+$/.test(value);
}

function isDictionary(value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function jsonPointer(path, component) {
  const escaped = component.replaceAll('~', '~0').replaceAll('/', '~1');
  return `${path}/${escaped}`;
}

function compareRemovals(lhs, rhs) {
  return compareStrings(lhs.path, rhs.path)
    || compareStrings(lhs.category, rhs.category)
    || compareStrings(lhs.field, rhs.field);
}

function compareStrings(lhs, rhs) {
  if (lhs === rhs) return 0;
  return lhs < rhs ? -1 : 1;
}

function boundaryError(code, path = null) {
  return new VoiceCredentialBoundaryError(code, path);
}
