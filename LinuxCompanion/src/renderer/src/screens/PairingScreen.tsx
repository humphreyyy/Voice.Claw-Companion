import { useEffect, useState } from 'react';
import QRCode from 'qrcode';

import type {
  CompanionSnapshot,
  PairingOptions,
  RealtimeAuthInput,
  VoiceClawDesktopAPI,
} from '../../../shared/contracts';
import {
  compactSetupDeepLink,
  redactedPairingPreview,
  setupDeepLink,
} from '../pairing';

const DEFAULT_OPTIONS: PairingOptions = {
  includeOpenAIAPIKey: true,
  includeCerebrasAPIKey: false,
  includeBridgeCredentials: true,
  includeChatGPTOAuth: true,
};

export function PairingScreen({
  api,
  snapshot,
  bridgeAvailable,
  pairingAvailable,
}: {
  api: VoiceClawDesktopAPI;
  snapshot: CompanionSnapshot | null;
  bridgeAvailable: boolean;
  pairingAvailable: boolean;
}) {
  const [options, setOptions] = useState(DEFAULT_OPTIONS);
  const [payload, setPayload] = useState<Record<string, unknown>>({});
  const [qrCode, setQRCode] = useState('');
  const [error, setError] = useState('');
  const [copied, setCopied] = useState('');
  const [realtimeAuthMode, setRealtimeAuthMode] =
    useState<RealtimeAuthInput['realtimeAuthMode']>('openclaw-oauth');
  const [fallback, setFallback] = useState(false);
  const [openAIAPIKey, setOpenAIAPIKey] = useState('');
  const [watchPublicBridgeURL, setWatchPublicBridgeURL] = useState('');
  const [authRevision, setAuthRevision] = useState(0);
  const [savingAuth, setSavingAuth] = useState(false);

  useEffect(() => {
    if (!snapshot) return;
    setRealtimeAuthMode(snapshot.config.realtimeAuthMode);
    setFallback(snapshot.config.realtimeAuthFallbackToAPIKey);
    setWatchPublicBridgeURL(snapshot.config.watchPublicBridgeURL);
  }, [snapshot]);

  useEffect(() => {
    if (!bridgeAvailable || !pairingAvailable) {
      setPayload({});
      setQRCode('');
      setError('');
      return undefined;
    }
    let active = true;
    api.getPairingPayload(options).then((nextPayload) => {
      if (!active) return;
      setPayload(nextPayload);
      setError('');
      return QRCode.toDataURL(compactSetupDeepLink(nextPayload, options), {
        errorCorrectionLevel: 'M',
        margin: 2,
        width: 280,
        color: { dark: '#07111fff', light: '#e7f1fbff' },
      });
    }).then((dataURL) => {
      if (active && dataURL) setQRCode(dataURL);
    }).catch(() => {
      if (active) setError('The local VoiceClaw bridge is not responding. Return to Set Up and restart it.');
    });
    return () => { active = false; };
  }, [api, authRevision, bridgeAvailable, options, pairingAvailable]);

  const saveAuth = async (next: Partial<RealtimeAuthInput> = {}) => {
    setSavingAuth(true);
    setError('');
    try {
      await api.updateRealtimeAuth({
        realtimeAuthMode: next.realtimeAuthMode ?? realtimeAuthMode,
        realtimeAuthFallbackToAPIKey:
          next.realtimeAuthFallbackToAPIKey ?? fallback,
        openAIAPIKey: next.openAIAPIKey ?? openAIAPIKey,
        watchPublicBridgeURL:
          next.watchPublicBridgeURL ?? watchPublicBridgeURL,
      });
      setAuthRevision((value) => value + 1);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setSavingAuth(false);
    }
  };
  const toggle = (key: keyof PairingOptions) => {
    setOptions((current) => ({ ...current, [key]: !current[key] }));
  };
  const copy = async (kind: 'json' | 'link') => {
    await api.copyText(kind === 'json' ? JSON.stringify(payload, null, 2) : setupDeepLink(payload));
    setCopied(kind);
    window.setTimeout(() => setCopied(''), 1_500);
  };
  const preview = redactedPairingPreview(payload);
  const authDetail = realtimeAuthMode === 'openclaw-oauth'
    ? "Use the Companion-managed ChatGPT subscription credential when available. The paired phone's authentication setting takes precedence."
    : 'Use an OpenAI API key included by the paired phone or available to the bridge environment.';

  return (
    <section className="screen panel parity-panel">
      <div className="screen-heading">
        <div>
          <h1>Pair Phone</h1>
          <p>Scan this QR code in VoiceClaw Realtime Settings. It syncs the bridge URL, OpenClaw settings, Hermes-capable route support, and Realtime authentication preferences.</p>
        </div>
      </div>

      {!pairingAvailable && <div className="callout callout-warning">Remote pairing is not ready. VoiceClaw Realtime on iPhone requires a dedicated Tailscale HTTPS origin or port; a path-only mapping such as /voice is not used for WebRTC signaling.</div>}
      {!bridgeAvailable && <div className="callout callout-warning">Install and Start the VoiceClaw bridge from Set Up before creating a pairing payload.</div>}

      <div className="parity-form pairing-preferences">
        <label>
          <strong>Realtime Auth</strong>
          <div>
            <select
              aria-label="Realtime Authentication"
              value={realtimeAuthMode}
              disabled={savingAuth}
              onChange={(event) => {
                const mode = event.target.value as RealtimeAuthInput['realtimeAuthMode'];
                setRealtimeAuthMode(mode);
                void saveAuth({ realtimeAuthMode: mode });
              }}
            >
              <option value="api-key">API Key</option>
              <option value="openclaw-oauth">OAuth (ChatGPT Subscription)</option>
            </select>
            <small>{authDetail}</small>
            <label className="toggle-row nested-toggle">
              <input
                type="checkbox"
                checked={fallback}
                disabled={realtimeAuthMode !== 'openclaw-oauth' || savingAuth}
                onChange={(event) => {
                  setFallback(event.target.checked);
                  void saveAuth({ realtimeAuthFallbackToAPIKey: event.target.checked });
                }}
              />
              Fall back to OpenAI API key if OAuth fails
            </label>
            <small>Pairing transfers the selected authentication preference and any credentials you explicitly include. When the paired phone has its own setting, the phone&apos;s setting takes precedence. Diagnostics reports whether OAuth and API-key credentials are available.</small>
          </div>
        </label>

        <label>
          <strong>OpenAI API Key</strong>
          <div>
            <input type="password" placeholder="sk-..." value={openAIAPIKey} onChange={(event) => setOpenAIAPIKey(event.target.value)} onBlur={() => void saveAuth()} />
            <label className="toggle-row nested-toggle"><input type="checkbox" checked={options.includeOpenAIAPIKey} onChange={() => toggle('includeOpenAIAPIKey')} />Include API Key in Setup QR</label>
            <small>On by default. When enabled, the QR code and setup JSON include this key so VoiceClaw Realtime stores it securely on the paired phone during pairing. The preview below redacts it.</small>
          </div>
        </label>

        <label>
          <strong>Bridge Credentials</strong>
          <div><label className="toggle-row nested-toggle"><input type="checkbox" checked={options.includeBridgeCredentials} onChange={() => toggle('includeBridgeCredentials')} />Include Bridge Credentials in Setup QR</label><small>On by default. The phone needs these credentials to authenticate Companion requests. Turning this off omits them and may require manual setup on the phone.</small></div>
        </label>

        <label>
          <strong>ChatGPT OAuth</strong>
          <div><label className="toggle-row nested-toggle"><input type="checkbox" checked={options.includeChatGPTOAuth} onChange={() => toggle('includeChatGPTOAuth')} />Include ChatGPT OAuth in Setup QR</label><small>On by default. Includes the Companion-managed ChatGPT OAuth credential set when available. The preview redacts token values.</small></div>
        </label>

        <label>
          <strong>Non-Tailscale HTTPS Bridge</strong>
          <div><input placeholder="https://..." value={watchPublicBridgeURL} onChange={(event) => setWatchPublicBridgeURL(event.target.value)} onBlur={() => void saveAuth()} /><small>Enter this only when a paired phone or watch should reach OpenClaw or Hermes Agent through a public HTTPS tunnel instead of the private Tailscale bridge. Leave it blank when paired devices use Tailscale, or when Apple Watch agent access always relays through the nearby iPhone.</small></div>
        </label>
      </div>

      <div className="info-card"><strong>OpenAI Auth Status</strong><span>{realtimeAuthMode === 'openclaw-oauth' ? 'OAuth (ChatGPT Subscription) is selected.' : 'API Key is selected.'} {snapshot?.config.hasOpenAIAPIKey ? 'An OpenAI API key is stored.' : 'No OpenAI API key is stored.'}</span></div>
      <div className="info-card"><strong>Which Runtime Handles the Work</strong><span>GPT Realtime handles the live conversation on iPhone or Apple Watch. OpenClaw routes send substantive work to the selected OpenClaw agent, Hermes routes use the Hermes Agent CLI, and Codex routes use Codex app-server. The Companion keeps those route tasks and returned files independent from the live voice connection.</span></div>
      <div className="info-card"><strong>iOS Widgets and Watch Extras</strong><span>For iPhone users, add VoiceClaw Realtime widgets from the iOS Home Screen widget gallery for one-tap route launches. You can also add VoiceClaw Realtime to the iPhone Lock Screen or Control Center for a quick Live launch; those controls open VoiceClaw Realtime directly on the iPhone, while this Companion is needed for OpenClaw and Hermes Bridge/Tunnel routes.</span></div>

      <div className="pairing-grid parity-pairing-grid">
        <section className="qr-panel">
          {qrCode && <div className="qr-wrap"><img src={qrCode} alt="VoiceClaw phone setup QR code" /><span>Click to enlarge</span></div>}
        </section>
        <section>
          <strong className="bridge-url">{String(payload.TailscaleBaseURL || 'Run setup to generate a Tailscale URL.')}</strong>
          {error ? <p className="error-copy">{error}</p> : <pre className="json-preview">{Object.keys(preview).length ? JSON.stringify(preview, null, 2) : 'No pairing payload yet.'}</pre>}
          <div className="pairing-actions">
            <button className="button button-secondary" type="button" disabled={!Object.keys(payload).length} onClick={() => void copy('json')}>{copied === 'json' ? 'Setup JSON Copied' : 'Copy Setup JSON'}</button>
            <button className="button button-secondary" type="button" disabled={!Object.keys(payload).length} onClick={() => void copy('link')}>{copied === 'link' ? 'Setup Link Copied' : 'Copy Setup Link'}</button>
          </div>
          {Object.keys(payload).length > 0 && compactSetupDeepLink(payload, options) !== setupDeepLink(payload) && <p className="fine-print">The QR code uses a compact secure setup link. Copy Setup JSON still contains the full payload shown above.</p>}
        </section>
      </div>
    </section>
  );
}
