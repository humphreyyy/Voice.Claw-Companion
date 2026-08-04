import type { CompanionSnapshot } from '../../../shared/contracts';
import { StatusRow } from '../components/StatusRow';

export function DiagnosticsScreen({
  snapshot,
  onVerify,
}: {
  snapshot: CompanionSnapshot | null;
  onVerify(): Promise<void>;
}) {
  const items = [...(snapshot?.diagnostics ?? []), ...(snapshot?.access ?? [])];
  const ready = snapshot?.service.active && snapshot?.tailscale.pairingCompatible;
  return (
    <section className="screen panel parity-panel">
      <div className="screen-heading">
        <div>
          <h1>Diagnostics</h1>
          <p>Use this when setup fails, pairing fails, or the phone cannot reach the Linux host. Verify Runtime runs the full readiness check and updates Last Checked when the cycle completes.</p>
        </div>
      </div>
      <div className="diagnostic-summary">
        <span>Local Bridge</span><strong>{snapshot?.service.summary ?? 'Not checked yet.'}</strong>
        <span>Tailscale Serve</span><strong>{snapshot?.tailscale.summary ?? 'Not checked yet.'}</strong>
        <span>Realtime Auth</span><strong>{snapshot?.config.realtimeAuthMode === 'openclaw-oauth' ? 'OAuth (ChatGPT Subscription)' : 'API Key'}, OpenAI API-key fallback {snapshot?.config.realtimeAuthFallbackToAPIKey ? 'on' : 'off'}.</strong>
        <span>Access and Permissions</span><strong>{snapshot?.access.length ? `${snapshot.access.filter((item) => item.state === 'ready').length} of ${snapshot.access.length} checks ready.` : 'Not checked yet.'}</strong>
        <span>Recommended Next Step</span><strong>{ready ? 'Open Pair Phone and scan the setup code in VoiceClaw Realtime Settings.' : 'Run Verify Runtime, then resolve the first item that needs action.'}</strong>
        <span>Launch upon Startup</span><strong>{snapshot?.launchAtLoginEnabled ? 'Enabled' : 'Disabled'}</strong>
        <span>Last Checked</span><strong>{snapshot ? new Date(snapshot.checkedAt).toLocaleString() : 'Not checked yet. Click Verify Runtime to run the full Companion readiness check.'}</strong>
      </div>

      <div className="form-actions diagnostics-actions"><button className="button button-secondary" type="button" onClick={() => void onVerify()}>Verify Runtime</button></div>
      <h2 className="section-title">Detailed Readiness Checks</h2>
      <div className="status-grid">
        {items.map((item, index) => <StatusRow key={`${item.id}-${index}`} item={item} />)}
      </div>
    </section>
  );
}
