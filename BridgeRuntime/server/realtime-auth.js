import { existsSync, readFileSync, realpathSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { homedir } from 'node:os';
import { pathToFileURL } from 'node:url';

const HOME = homedir();
const BRIDGE_CONFIG_FILE = join(HOME, '.voiceclaw', 'bridge.json');
const OPENCLAW_BIN = process.env.OPENCLAW_BIN || '/opt/homebrew/bin/openclaw';
const OPENCLAW_CONFIG = process.env.OPENCLAW_CONFIG || join(HOME, '.openclaw', 'openclaw.json');
const OPENCLAW_INSTALL_PATH = process.env.OPENCLAW_INSTALL_PATH || join(HOME, '.openclaw');
const OPENAI_REALTIME_CLIENT_SECRETS_URL = 'https://api.openai.com/v1/realtime/client_secrets';

export const REALTIME_AUTH_MODE_API_KEY = 'api-key';
export const REALTIME_AUTH_MODE_OPENCLAW_OAUTH = 'openclaw-oauth';

let providerAuthModulePromise = null;

export function readBridgeConfig() {
  try {
    return JSON.parse(readFileSync(BRIDGE_CONFIG_FILE, 'utf8'));
  } catch {
    return {};
  }
}

function readOpenClawConfig() {
  try {
    return JSON.parse(readFileSync(OPENCLAW_CONFIG, 'utf8'));
  } catch {
    return {};
  }
}

export function normalizeRealtimeAuthMode(value) {
  const normalized = String(value || '').trim().toLowerCase();
  if (normalized === REALTIME_AUTH_MODE_OPENCLAW_OAUTH || normalized === 'oauth' || normalized === 'openclaw') {
    return REALTIME_AUTH_MODE_OPENCLAW_OAUTH;
  }
  return REALTIME_AUTH_MODE_API_KEY;
}

export function parseRealtimeBoolean(value, fallback = false) {
  if (value === undefined || value === null || value === '') return fallback;
  const normalized = String(value).trim().toLowerCase();
  if (['1', 'true', 'yes', 'on'].includes(normalized)) return true;
  if (['0', 'false', 'no', 'off'].includes(normalized)) return false;
  return fallback;
}

export function realtimeAuthPreferences(req) {
  const bridgeConfig = readBridgeConfig();
  const requestedMode = req?.headers?.['x-voiceclaw-realtime-auth-mode']
    ?? req?.headers?.['x-voiceclaw-auth-mode'];
  const configuredMode = process.env.VOICECLAW_REALTIME_AUTH_MODE
    ?? bridgeConfig.realtimeAuthMode
    ?? REALTIME_AUTH_MODE_OPENCLAW_OAUTH;
  const requestedFallback = req?.headers?.['x-voiceclaw-realtime-auth-fallback']
    ?? req?.headers?.['x-voiceclaw-api-key-fallback'];
  const configuredFallback = process.env.VOICECLAW_REALTIME_AUTH_FALLBACK_TO_API_KEY
    ?? bridgeConfig.realtimeAuthFallbackToAPIKey;

  return {
    mode: normalizeRealtimeAuthMode(requestedMode ?? configuredMode),
    fallbackToAPIKey: parseRealtimeBoolean(requestedFallback, parseRealtimeBoolean(configuredFallback, false)),
    source: requestedMode === undefined ? 'companion-default' : 'paired-phone',
  };
}

function bearerFromPairedPhoneClientSecret(req) {
  const value = String(req?.headers?.['x-voiceclaw-realtime-client-secret'] || '').trim();
  if (!value) return '';
  return value;
}

function resolveOpenClawPackageRoot() {
  try {
    const binRealPath = realpathSync(OPENCLAW_BIN);
    const binDir = dirname(binRealPath);
    if (existsSync(join(binDir, 'dist', 'plugin-sdk', 'provider-auth.js'))) {
      return binDir;
    }
  } catch {}

  const candidates = [
    join(OPENCLAW_INSTALL_PATH, 'node_modules', 'openclaw'),
    OPENCLAW_INSTALL_PATH,
    '/opt/homebrew/lib/node_modules/openclaw',
    '/usr/local/lib/node_modules/openclaw',
  ];

  return candidates.find((candidate) => existsSync(join(candidate, 'dist', 'plugin-sdk', 'provider-auth.js'))) || '';
}

async function loadOpenClawProviderAuthModule() {
  if (providerAuthModulePromise) return providerAuthModulePromise;

  providerAuthModulePromise = (async () => {
    const packageRoot = resolveOpenClawPackageRoot();
    if (!packageRoot) {
      throw new Error('OpenClaw provider auth module was not found. Install or update OpenClaw 2026.5.12 or later.');
    }

    return import(pathToFileURL(join(packageRoot, 'dist', 'plugin-sdk', 'provider-auth.js')).href);
  })();

  return providerAuthModulePromise;
}

async function resolveOpenClawOAuthBearer() {
  const providerAuth = await loadOpenClawProviderAuthModule();
  const cfg = readOpenClawConfig();
  const token = await providerAuth.resolveProviderAuthProfileApiKey({
    provider: 'openai-codex',
    cfg,
  });

  if (!token) {
    throw new Error('No OpenClaw OpenAI OAuth profile is available. Run: openclaw models auth login --provider openai --set-default');
  }

  if (/^sk-/.test(token)) {
    throw new Error('OpenClaw returned an API-key auth profile, not a ChatGPT/Codex OAuth profile. Run: openclaw models auth login --provider openai --set-default');
  }

  return token;
}

export async function createRealtimeClientSecret({ authToken, session }) {
  const response = await fetch(OPENAI_REALTIME_CLIENT_SECRETS_URL, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${authToken}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ session }),
  });
  const body = await response.text();
  let payload = {};
  try {
    payload = JSON.parse(body || '{}');
  } catch {}

  if (!response.ok) {
    const detail = payload?.error?.message || payload?.message || body || `HTTP ${response.status}`;
    throw new Error(`GPT-Realtime-2 client secret failed: ${detail}`);
  }

  const clientSecret = payload?.value || payload?.client_secret?.value;
  if (!clientSecret) {
    throw new Error('GPT-Realtime-2 client secret response did not include a value.');
  }

  return {
    value: clientSecret,
    expiresAt: typeof payload?.expires_at === 'number' ? payload.expires_at : undefined,
  };
}

export async function resolveRealtimeBearer({ req, session, apiKey }) {
  const preferences = realtimeAuthPreferences(req);

  if (preferences.mode === REALTIME_AUTH_MODE_API_KEY) {
    if (!apiKey) {
      throw new Error('OpenAI API key is not configured.');
    }
    return {
      bearer: apiKey,
      sidebandBearer: apiKey,
      source: REALTIME_AUTH_MODE_API_KEY,
      preferences,
    };
  }

  const pairedPhoneClientSecret = bearerFromPairedPhoneClientSecret(req);
  if (pairedPhoneClientSecret) {
    return {
      bearer: pairedPhoneClientSecret,
      // The Realtime sideband connection is part of the same session. Prefer a
      // server API key if configured, otherwise use the phone-minted short-lived
      // client secret for the Companion-owned sideband connection as well.
      sidebandBearer: apiKey || pairedPhoneClientSecret,
      source: 'paired-phone-oauth',
      preferences,
    };
  }

  try {
    const oauthBearer = await resolveOpenClawOAuthBearer();
    const clientSecret = await createRealtimeClientSecret({
      authToken: oauthBearer,
      session,
    });
    return {
      bearer: clientSecret.value,
      // OpenAI's sideband WebSocket examples use a server API key. OAuth can
      // mint the client secret used by the iPhone, but prefer the API key for
      // server-owned tool control when the user supplied one.
      sidebandBearer: apiKey || oauthBearer,
      source: REALTIME_AUTH_MODE_OPENCLAW_OAUTH,
      expiresAt: clientSecret.expiresAt,
      preferences,
    };
  } catch (error) {
    if (preferences.fallbackToAPIKey && apiKey) {
      return {
        bearer: apiKey,
        sidebandBearer: apiKey,
        source: 'api-key-fallback',
        oauthError: error?.message || String(error),
        preferences,
      };
    }

    const baseMessage = error?.message || String(error);
    const phoneHint = preferences.source === 'paired-phone'
      ? ' The paired phone selected OAuth but did not provide an iPhone-minted GPT-Realtime-2 client secret, so the Companion tried its local OpenClaw OAuth profile instead.'
      : '';
    throw new Error(`${baseMessage}${phoneHint}${preferences.fallbackToAPIKey ? ' API-key fallback is enabled, but no API key was available.' : ' API-key fallback is off.'}`);
  }
}

export async function buildRealtimeAuthStatus({ req, apiKey, probe = false, model = 'gpt-realtime-2', voice = 'marin' }) {
  const preferences = realtimeAuthPreferences(req);
  const status = {
    ok: true,
    mode: preferences.mode,
    effectiveSource: preferences.source,
    fallbackToAPIKey: preferences.fallbackToAPIKey,
    apiKeyAvailable: Boolean(apiKey),
    openClawOAuth: {
      checked: false,
      available: false,
    },
  };

  if (preferences.mode !== REALTIME_AUTH_MODE_OPENCLAW_OAUTH && !probe) {
    return status;
  }

  status.openClawOAuth.checked = true;
  try {
    const oauthBearer = await resolveOpenClawOAuthBearer();
    status.openClawOAuth.available = true;

    if (probe) {
      await createRealtimeClientSecret({
        authToken: oauthBearer,
        session: {
          type: 'realtime',
          model,
          audio: {
            output: { voice },
          },
        },
      });
      status.openClawOAuth.clientSecretProbe = 'passed';
    }
  } catch (error) {
    status.openClawOAuth.available = false;
    status.openClawOAuth.error = error?.message || String(error);
    if (probe) status.openClawOAuth.clientSecretProbe = 'failed';
  }

  return status;
}
