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

function payloadEndpoint(value: unknown): string {
  if (typeof value !== 'string' || value.trim() === '') return '';
  try {
    const url = new URL(value.trim());
    url.pathname = `${url.pathname.replace(/\/+$/u, '')}/realtime/setup-payload`;
    url.search = '';
    return url.toString();
  } catch {
    return '';
  }
}

export function compactSetupDeepLink(
  payload: Record<string, unknown>,
  options: {
    includeBridgeCredentials: boolean;
    includeChatGPTOAuth: boolean;
  },
): string {
  const token = String(payload.OpenClawGatewayToken || payload.gatewayToken || '').trim();
  const password = String(payload.OpenClawGatewayPassword || '').trim();
  if (!options.includeBridgeCredentials || (!token && !password)) {
    return setupDeepLink(payload);
  }
  const endpoints = [payload.WatchPublicBridgeURL, payload.TailscaleBaseURL]
    .map(payloadEndpoint)
    .filter((value, index, values) => value !== '' && values.indexOf(value) === index)
    .map((value) => {
      const url = new URL(value);
      url.searchParams.set('include_openai_key', String(Boolean(payload.OpenAIAPIKey) ? 1 : 0));
      url.searchParams.set('include_cerebras_key', String(Boolean(payload.CerebrasAPIKey) ? 1 : 0));
      url.searchParams.set('include_bridge_credentials', '1');
      url.searchParams.set('include_chatgpt_oauth', options.includeChatGPTOAuth ? '1' : '0');
      return url.toString();
    });
  if (!endpoints.length) return setupDeepLink(payload);
  const query = new URLSearchParams({ v: '2' });
  for (const endpoint of endpoints) query.append('payload_url', endpoint);
  if (token) query.set('gateway_token', token);
  if (password) query.set('gateway_password', password);
  return `voiceclaw://setup?${query.toString()}`;
}
