import type { CompanionSnapshot, VoiceClawDesktopAPI } from '../../../shared/contracts';
import { StatusBadge } from '../components/StatusBadge';

export function TailscaleScreen({
  snapshot,
  api,
  onVerify,
}: {
  snapshot: CompanionSnapshot | null;
  api: VoiceClawDesktopAPI;
  onVerify(): Promise<void>;
}) {
  const tailscale = snapshot?.tailscale;
  return (
    <section className="screen panel parity-panel">
      <div className="screen-heading">
        <div><h1>Tailscale</h1><p>VoiceClaw Realtime uses Tailscale Serve so the paired phone can reach this Linux host on your private network for OpenClaw and Hermes Agent routes.</p></div>
      </div>
      <div className="info-card"><strong>What Tailscale Serve Is</strong><span>Tailscale Serve is a private HTTPS reverse proxy: it takes a Tailscale URL on this Linux host and forwards it to the local VoiceClaw Realtime bridge running on 127.0.0.1. It is private to devices in your tailnet, not a public internet link.</span></div>
      <div className="info-card"><strong>Why the URL has a port</strong><span>The port selects the VoiceClaw Realtime bridge service on this Linux host. Your existing Serve mapping may expose it at a path such as /voice instead. If you change the bridge port, run Install and Start again and pair the phone with the new QR code.</span></div>
      <div className="info-card"><strong>What Must Be Allowed</strong><span>Tailscale must be installed and signed in, and HTTPS certificates must be enabled for your tailnet. If you are not the tailnet owner or admin, ask that person to enable HTTPS certificates. Verify Runtime checks the bridge and your existing Serve mapping.</span></div>
      <div className="info-card"><strong>Why VoiceClaw Realtime Does Not Use Serve Reset</strong><span>Tailscale&apos;s full Serve reset clears every Serve mapping on this Linux host. This Linux port never resets or changes your existing Tailscale Serve mappings.</span></div>

      <article className="status-row tailscale-status-row">
        <div className="status-row-heading"><h3>Tailscale Serve</h3><StatusBadge state={tailscale?.pairingCompatible ? 'ready' : 'warning'} /></div>
        <p>{tailscale?.summary ?? 'Checking your existing Tailscale state…'}</p>
        <code>{tailscale?.serveURL || 'No matching Serve URL detected for this bridge port.'}</code>
      </article>

      {tailscale?.serveMapped && !tailscale.pairingCompatible && (
        <div className="callout callout-warning">
          The existing path mapping remains untouched. Add a separate HTTPS port manually, then click Install and Start again: <code>tailscale serve --bg --https={snapshot?.config.port ?? 12321} http://127.0.0.1:{snapshot?.config.port ?? 12321}{tailscale.serveBasePath || ''}</code>
        </div>
      )}

      <div className="form-actions wrap-actions tailscale-actions">
        <button className="button button-secondary" type="button" onClick={() => void api.openURL('https://tailscale.com/download/linux')}>Get Tailscale</button>
        <button className="button button-secondary" type="button" onClick={() => void api.openURL('https://login.tailscale.com/admin/machines')}>Admin Console</button>
        <button className="button button-secondary" type="button" onClick={() => void api.openURL('https://tailscale.com/kb/1242/tailscale-serve')}>Serve Help</button>
        <button className="button button-secondary" type="button" onClick={() => void onVerify()}>Verify Runtime</button>
      </div>
    </section>
  );
}
