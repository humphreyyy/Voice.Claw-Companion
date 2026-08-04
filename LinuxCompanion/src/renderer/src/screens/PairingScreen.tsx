import { useEffect, useState } from 'react';
import QRCode from 'qrcode';

import type {
  PairingOptions,
  VoiceClawDesktopAPI,
} from '../../../shared/contracts';
import { redactedPairingPreview, setupDeepLink } from '../pairing';

const DEFAULT_OPTIONS: PairingOptions = {
  includeOpenAIAPIKey: false,
  includeCerebrasAPIKey: false,
  includeBridgeCredentials: true,
  includeChatGPTOAuth: true,
};

export function PairingScreen({
  api,
  bridgeAvailable,
  pairingAvailable,
}: {
  api: VoiceClawDesktopAPI;
  bridgeAvailable: boolean;
  pairingAvailable: boolean;
}) {
  const [options, setOptions] = useState(DEFAULT_OPTIONS);
  const [payload, setPayload] = useState<Record<string, unknown>>({});
  const [qrCode, setQRCode] = useState('');
  const [error, setError] = useState('');
  const [copied, setCopied] = useState('');

  useEffect(() => {
    if (!bridgeAvailable) {
      setPayload({});
      setQRCode('');
      setError('');
      return undefined;
    }
    let active = true;
    api.getPairingPayload(options).then((payload) => {
      if (!active) return;
      setPayload(payload);
      setError('');
      return QRCode.toDataURL(setupDeepLink(payload), {
        errorCorrectionLevel: 'M',
        margin: 2,
        width: 280,
        color: { dark: '#07111fff', light: '#e7f1fbff' },
      });
    }).then((dataURL) => {
      if (active && dataURL) setQRCode(dataURL);
    }).catch((caught: unknown) => {
      if (active) {
        setError('The local VoiceClaw bridge is not responding. Return to Set Up and restart it.');
      }
    });
    return () => {
      active = false;
    };
  }, [api, bridgeAvailable, options]);

  const toggle = (key: keyof PairingOptions) => {
    setOptions((current) => ({ ...current, [key]: !current[key] }));
  };
  const copy = async (kind: 'json' | 'link') => {
    const value = kind === 'json'
      ? JSON.stringify(payload, null, 2)
      : setupDeepLink(payload);
    await api.copyText(value);
    setCopied(kind);
    window.setTimeout(() => setCopied(''), 1_500);
  };
  const preview = redactedPairingPreview(payload);
  return (
    <section className="screen">
      <div className="screen-heading">
        <div>
          <span className="eyebrow">Manual handoff</span>
          <h1>Pair Phone</h1>
          <p>Transfer bridge settings and runtime support to your iPhone. Nothing is sent automatically.</p>
        </div>
      </div>
      {!pairingAvailable && (
        <div className="callout callout-warning">
          Remote pairing is not ready. Check the bridge and your existing Tailscale Serve mapping.
        </div>
      )}
      {!bridgeAvailable && (
        <div className="callout callout-warning">
          Install and Start the VoiceClaw bridge from Set Up before creating a pairing payload.
        </div>
      )}
      <div className="callout">
        <strong>Which runtime handles the work?</strong> The phone chooses the route for each task: OpenClaw uses the configured agent, Hermes uses your local Hermes environment, Codex uses the local Codex CLI, and GPT Realtime handles live conversation.
      </div>
      <div className="pairing-grid">
        <section className="panel">
          <div className="panel-title"><span>Payload contents</span></div>
          {([
            ['includeBridgeCredentials', 'Bridge credentials'],
            ['includeChatGPTOAuth', 'ChatGPT OAuth'],
            ['includeOpenAIAPIKey', 'OpenAI API key'],
          ] as Array<[keyof PairingOptions, string]>).map(([key, label]) => (
            <label className="toggle-card" key={key}>
              <input type="checkbox" checked={options[key]} onChange={() => toggle(key)} />
              <span><strong>{label}</strong><small>Include only when your phone needs it.</small></span>
            </label>
          ))}
          <div className="pairing-actions">
            <button
              className="button button-primary"
              type="button"
              disabled={!Object.keys(payload).length}
              onClick={() => void copy('json')}
            >
              {copied === 'json' ? 'Setup JSON Copied' : 'Copy Setup JSON'}
            </button>
            <button
              className="button button-secondary"
              type="button"
              disabled={!Object.keys(payload).length}
              onClick={() => void copy('link')}
            >
              {copied === 'link' ? 'Setup Link Copied' : 'Copy Setup Link'}
            </button>
          </div>
        </section>
        <section className="panel">
          <div className="panel-title"><span>Redacted preview</span><small>Secrets never render here</small></div>
          {error
            ? <p className="error-copy">{error}</p>
            : (
              <>
                {qrCode && (
                  <div className="qr-wrap">
                    <img src={qrCode} alt="VoiceClaw phone setup QR code" />
                    <span>Scan manually with your iPhone</span>
                  </div>
                )}
                <pre className="json-preview">{JSON.stringify(preview, null, 2)}</pre>
              </>
            )}
        </section>
      </div>
    </section>
  );
}
