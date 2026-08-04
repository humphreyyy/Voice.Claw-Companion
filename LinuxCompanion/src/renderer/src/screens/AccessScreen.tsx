import type {
  CompanionSnapshot,
  SetupInput,
  VoiceClawDesktopAPI,
} from '../../../shared/contracts';
import { StatusRow } from '../components/StatusRow';

export function AccessScreen({
  snapshot,
  api,
  onVerify,
  onInstall,
  onEnableStartup,
}: {
  snapshot: CompanionSnapshot | null;
  api: VoiceClawDesktopAPI;
  onVerify(): Promise<void>;
  onInstall(input: SetupInput): Promise<void>;
  onEnableStartup(): Promise<void>;
}) {
  const install = () => {
    if (!snapshot) return;
    void onInstall({
      port: snapshot.config.port,
      openClawInstallPath: snapshot.config.openClawInstallPath,
      openClawAgentName: snapshot.config.openClawAgentName,
      realtimeAuthMode: snapshot.config.realtimeAuthMode,
      realtimeAuthFallbackToAPIKey: snapshot.config.realtimeAuthFallbackToAPIKey,
      openAIAPIKey: '',
    });
  };
  return (
    <section className="screen panel parity-panel">
      <div className="screen-heading">
        <div>
          <h1>Access and Permissions</h1>
          <p>Prepare this Linux host up front so phone and watch sessions do not pause later for missing runtime access, missing folders, or desktop approval.</p>
        </div>
      </div>
      <div className="info-card"><strong>What Linux requires</strong><span>VoiceClaw Realtime can install its local bridge and check the desktop session, but Linux still requires the user to approve protected access such as Microphone, Files and Folders, and Local Network when those prompts appear.</span></div>
      <div className="info-card"><strong>What VoiceClaw Realtime uses</strong><span>The Companion writes local config under ~/.voiceclaw, starts a per-user systemd service, serves a local bridge on the selected port, and can run OpenClaw, Hermes Agent, or Codex work from this Linux host when those routes are selected.</span></div>

      <section className="inset-section">
        <h2>Current Readiness</h2>
        <div className="status-grid">
          {snapshot?.access.map((item) => <StatusRow key={item.id} item={item} />)}
        </div>
      </section>

      <section className="inset-section">
        <h2>Prepare This Linux Host</h2>
        <div className="form-actions wrap-actions">
          <button className="button button-secondary" type="button" onClick={() => void onEnableStartup()}>Enable Login Item</button>
          <button className="button button-secondary" type="button" disabled={!snapshot} onClick={() => snapshot && void api.openPath(snapshot.config.openClawInstallPath)}>Open OpenClaw Folder</button>
        </div>
      </section>

      <div className="form-actions wrap-actions">
        <button className="button button-secondary" type="button" onClick={() => void onVerify()}>Verify Everything</button>
        <button className="button button-primary" type="button" disabled={!snapshot} onClick={install}>Install and Start Bridge</button>
      </div>
      <p className="fine-print">VoiceClaw Realtime does not use or contact unrelated local services outside its own bridge/runtime paths. Personal development services on other ports should remain isolated from Companion setup.</p>
    </section>
  );
}
