import { useEffect, useState } from 'react';

import type {
  PairingOptions,
  VoiceClawDesktopAPI,
} from '../../../shared/contracts';

const DEFAULT_OPTIONS: PairingOptions = {
  includeOpenAIAPIKey: false,
  includeCerebrasAPIKey: false,
  includeBridgeCredentials: true,
  includeChatGPTOAuth: true,
};

function redacted(value: unknown, key = ''): unknown {
  if (/key|token|secret|oauth|credential/iu.test(key)) {
    return '••••••••';
  }
  if (Array.isArray(value)) {
    return value.map((entry) => redacted(entry));
  }
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value).map(([childKey, child]) => [childKey, redacted(child, childKey)]),
    );
  }
  return value;
}

export function PairingScreen({
  api,
  pairingAvailable,
}: {
  api: VoiceClawDesktopAPI;
  pairingAvailable: boolean;
}) {
  const [options, setOptions] = useState(DEFAULT_OPTIONS);
  const [preview, setPreview] = useState<Record<string, unknown>>({});
  const [error, setError] = useState('');

  useEffect(() => {
    let active = true;
    api.getPairingPayload(options).then((payload) => {
      if (active) {
        setPreview(redacted(payload) as Record<string, unknown>);
        setError('');
      }
    }).catch((caught: unknown) => {
      if (active) {
        setError(caught instanceof Error ? caught.message : String(caught));
      }
    });
    return () => {
      active = false;
    };
  }, [api, options]);

  const toggle = (key: keyof PairingOptions) => {
    setOptions((current) => ({ ...current, [key]: !current[key] }));
  };
  return (
    <section className="screen">
      <div className="screen-heading">
        <div>
          <span className="eyebrow">Manual handoff</span>
          <h1>Pair Phone</h1>
          <p>Choose exactly which credentials belong in the setup payload. Nothing is sent automatically.</p>
        </div>
      </div>
      {!pairingAvailable && (
        <div className="callout callout-warning">
          Remote pairing is not ready. Check the bridge and your existing Tailscale Serve mapping.
        </div>
      )}
      <div className="pairing-grid">
        <section className="panel">
          <div className="panel-title"><span>Payload contents</span></div>
          {([
            ['includeBridgeCredentials', 'Bridge credentials'],
            ['includeChatGPTOAuth', 'ChatGPT OAuth'],
            ['includeOpenAIAPIKey', 'OpenAI API key'],
            ['includeCerebrasAPIKey', 'Cerebras API key'],
          ] as Array<[keyof PairingOptions, string]>).map(([key, label]) => (
            <label className="toggle-card" key={key}>
              <input type="checkbox" checked={options[key]} onChange={() => toggle(key)} />
              <span><strong>{label}</strong><small>Include only when your phone needs it.</small></span>
            </label>
          ))}
        </section>
        <section className="panel">
          <div className="panel-title"><span>Redacted preview</span><small>Secrets never render here</small></div>
          {error
            ? <p className="error-copy">{error}</p>
            : <pre className="json-preview">{JSON.stringify(preview, null, 2)}</pre>}
        </section>
      </div>
    </section>
  );
}
