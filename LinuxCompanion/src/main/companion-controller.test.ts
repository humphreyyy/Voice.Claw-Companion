// @vitest-environment node

import { describe, expect, it, vi } from 'vitest';

import type {
  BridgeConfig,
  CompanionSnapshot,
  ServiceStatus,
  TailscaleStatus,
} from '../shared/contracts';
import {
  CompanionController,
  type CompanionControllerDependencies,
} from './companion-controller';

const config: BridgeConfig = {
  port: 12_321,
  openClawInstallPath: '/home/tester/.openclaw',
  openClawAgentName: 'main',
  realtimeAuthMode: 'openclaw-oauth',
  realtimeAuthFallbackToAPIKey: false,
  openAIAPIKey: 'sk-secret',
  gatewayToken: 'A'.repeat(43),
  tailscaleDNSName: '',
  tailscaleBaseURL: '',
};

const serviceStatus: ServiceStatus = {
  installed: true,
  enabled: true,
  active: true,
  loadState: 'loaded',
  activeState: 'active',
  subState: 'running',
  summary: 'running',
};

const tailscaleStatus: TailscaleStatus = {
  installed: true,
  connected: true,
  dnsName: 'openclaw.tailnet.ts.net',
  serveURL: 'https://openclaw.tailnet.ts.net:12321',
  serveMapped: true,
  summary: 'mapped',
};

function dependencies(events: string[] = []): CompanionControllerDependencies {
  let current = config;
  let tailscaleCalls = 0;
  return {
    configStore: {
      async read() {
        return current;
      },
      async write() {
        events.push('config.write');
        current = config;
        return current;
      },
      async updateNetwork(dnsName, baseURL) {
        events.push('config.update-network');
        current = { ...current, tailscaleDNSName: dnsName, tailscaleBaseURL: baseURL };
        return current;
      },
      async remove() {},
    },
    tailscale: {
      async status() {
        if (tailscaleCalls++ === 0) {
          events.push('tailscale.status');
        }
        return tailscaleStatus;
      },
    },
    systemd: {
      async installAndStart() {
        events.push('systemd.install-and-start');
        return serviceStatus;
      },
      async restart() {
        return serviceStatus;
      },
      async status() {
        return serviceStatus;
      },
      async logTail() {
        return '';
      },
      async remove() {},
    },
    autostart: {
      async isEnabled() {
        return true;
      },
      async setEnabled(enabled) {
        return enabled;
      },
    },
    diagnostics: {
      async check() {
        return [];
      },
    },
    paths: {
      configDir: '/home/tester/.voiceclaw',
      configFile: '/home/tester/.voiceclaw/bridge.json',
      systemdDir: '/home/tester/.config/systemd/user',
      unitFile: '/home/tester/.config/systemd/user/voiceclaw-companion-bridge.service',
      autostartDir: '/home/tester/.config/autostart',
      autostartFile: '/home/tester/.config/autostart/voiceclaw-companion.desktop',
      dataDir: '/home/tester/.local/share/voiceclaw-companion',
      cacheDir: '/home/tester/.cache/voiceclaw-companion',
    },
    executablePath: '/opt/VoiceClaw Companion/voiceclaw-companion',
    serviceEntryPath: '/opt/VoiceClaw Companion/resources/service/bridge-entry.mjs',
    bridgeClientFactory: () => ({
      async health() {
        return { ok: true };
      },
      async status() {
        return { ok: true };
      },
      async authStatus() {
        return { ok: true };
      },
      async setupPayload() {
        return {};
      },
      async tasks() {
        return [];
      },
      async artifacts() {
        return [];
      },
      async deleteArtifact() {},
      async emptyArtifacts() {},
    }),
    async waitForHealth() {
      events.push('bridge.wait-for-health');
    },
  };
}

describe('CompanionController', () => {
  it('installs in dependency order without asking Tailscale to mutate state', async () => {
    const events: string[] = [];
    const controller = new CompanionController(dependencies(events));
    const snapshot = { checkedAt: 1 } as CompanionSnapshot;
    vi.spyOn(controller, 'getSnapshot').mockImplementation(async () => {
      events.push('snapshot');
      return snapshot;
    });

    await controller.installAndStart(config);

    expect(events).toEqual([
      'config.write',
      'tailscale.status',
      'config.update-network',
      'systemd.install-and-start',
      'bridge.wait-for-health',
      'snapshot',
    ]);
  });

  it('never exposes the API key or gateway token in a snapshot', async () => {
    const snapshot = await new CompanionController(dependencies()).getSnapshot();
    expect(snapshot.config).toEqual({
      port: 12_321,
      openClawInstallPath: '/home/tester/.openclaw',
      openClawAgentName: 'main',
      realtimeAuthMode: 'openclaw-oauth',
      realtimeAuthFallbackToAPIKey: false,
      hasOpenAIAPIKey: true,
    });
    expect(snapshot.launchAtLoginEnabled).toBe(true);
    expect(JSON.stringify(snapshot)).not.toContain('sk-secret');
    expect(JSON.stringify(snapshot)).not.toContain('A'.repeat(43));
  });

  it('keeps a snapshot available when optional integrations reject', async () => {
    const deps = dependencies();
    deps.systemd.status = async () => {
      throw new Error('systemd missing');
    };
    deps.tailscale.status = async () => {
      throw new Error('tailscale missing');
    };
    deps.bridgeClientFactory = () => ({
      async health() {
        throw new Error('bridge missing');
      },
      async status() {
        throw new Error('bridge missing');
      },
      async authStatus() {
        throw new Error('bridge missing');
      },
      async setupPayload() {
        throw new Error('bridge missing');
      },
      async tasks() {
        throw new Error('bridge missing');
      },
      async artifacts() {
        throw new Error('bridge missing');
      },
      async deleteArtifact() {},
      async emptyArtifacts() {},
    });

    const snapshot = await new CompanionController(deps).getSnapshot();
    expect(snapshot.config.port).toBe(12_321);
    expect(snapshot.service.active).toBe(false);
    expect(snapshot.tailscale.connected).toBe(false);
    expect(snapshot.tasks).toEqual([]);
    expect(snapshot.artifacts).toEqual([]);
  });

  it('suggests an available loopback port', async () => {
    const port = await new CompanionController(dependencies()).suggestPort();
    expect(port).toBeGreaterThan(0);
    expect(port).toBeLessThanOrEqual(65_535);
  });
});
