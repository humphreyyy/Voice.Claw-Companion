const SECRET_FIELD = /(?:api.?key|token|secret|password|oauth|credential|authorization|bearer)/iu;

function redact(value: unknown, fieldName = ''): unknown {
  if (SECRET_FIELD.test(fieldName)) {
    return '••••••••';
  }
  if (Array.isArray(value)) {
    return value.map((entry) => redact(entry));
  }
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value).map(([key, child]) => [key, redact(child, key)]),
    );
  }
  return value;
}

export function redactedPairingPreview(
  payload: Record<string, unknown>,
): Record<string, unknown> {
  return redact(payload) as Record<string, unknown>;
}

function base64URL(value: string): string {
  const bytes = new TextEncoder().encode(value);
  let binary = '';
  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }
  return btoa(binary)
    .replace(/\+/gu, '-')
    .replace(/\//gu, '_')
    .replace(/=+$/gu, '');
}

export function setupDeepLink(payload: Record<string, unknown>): string {
  return `voiceclaw://setup?payload=${base64URL(JSON.stringify(payload))}`;
}
