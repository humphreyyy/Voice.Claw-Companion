import type { VoiceClawDesktopAPI } from '../../shared/contracts';
import { AppShell } from './components/AppShell';
import { CompanionOverview } from './components/CompanionOverview';
import { AccessScreen } from './screens/AccessScreen';
import { DiagnosticsScreen } from './screens/DiagnosticsScreen';
import { PairingScreen } from './screens/PairingScreen';
import { SetupScreen } from './screens/SetupScreen';
import { TailscaleScreen } from './screens/TailscaleScreen';
import { TasksFilesScreen } from './screens/TasksFilesScreen';
import { useCompanion } from './use-companion';

function CompanionApp({ api }: { api: VoiceClawDesktopAPI }) {
  const companion = useCompanion(api);
  const screen = (() => {
    switch (companion.selectedSection) {
      case 'access':
        return <AccessScreen snapshot={companion.snapshot} />;
      case 'tasks':
        return (
          <TasksFilesScreen
            snapshot={companion.snapshot}
            api={api}
            onRefresh={companion.refresh}
          />
        );
      case 'pairing':
        return (
          <PairingScreen
            api={api}
            bridgeAvailable={companion.snapshot?.service.active ?? false}
            pairingAvailable={companion.snapshot?.pairingAvailable ?? false}
          />
        );
      case 'tailscale':
        return <TailscaleScreen snapshot={companion.snapshot} />;
      case 'diagnostics':
        return <DiagnosticsScreen snapshot={companion.snapshot} />;
      case 'setup':
      default:
        return (
          <SetupScreen
            snapshot={companion.snapshot}
            busy={companion.busyAction}
            onInstall={companion.install}
            onRestart={companion.restart}
            onReset={companion.reset}
            onSuggestPort={companion.suggestPort}
          />
        );
    }
  })();

  return (
    <AppShell
      snapshot={companion.snapshot}
      selected={companion.selectedSection}
      onSelect={companion.setSelectedSection}
      onRefresh={() => void companion.refresh()}
      refreshing={companion.busyAction === 'refresh'}
    >
      <CompanionOverview
        snapshot={companion.snapshot}
        busy={companion.busyAction === 'autostart'}
        onSetLaunchAtLogin={companion.setLaunchAtLogin}
      />
      {companion.error && <div className="error-banner" role="alert">{companion.error}</div>}
      {screen}
    </AppShell>
  );
}

export function App({ api }: { api?: VoiceClawDesktopAPI }) {
  const desktopAPI = api ?? window.voiceclaw;
  if (!desktopAPI) {
    return (
      <main className="startup-failure">
        <section className="panel">
          <span className="eyebrow">Desktop integration unavailable</span>
          <h1>VoiceClaw could not start</h1>
          <div className="error-banner" role="alert">
            VoiceClaw desktop integration did not load. Quit the app and install
            the latest Linux package before trying again.
          </div>
        </section>
      </main>
    );
  }
  return <CompanionApp api={desktopAPI} />;
}
