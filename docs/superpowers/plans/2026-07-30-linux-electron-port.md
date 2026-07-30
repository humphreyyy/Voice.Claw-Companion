# VoiceClaw Companion Linux Electron Port Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build and install a full VoiceClaw Companion desktop port for Ubuntu
24.04 x86-64 while preserving the existing macOS application and reusing the
existing Node bridge.

**Architecture:** Add a context-isolated Electron/React application beside the
SwiftUI target. The Electron main process owns a narrow IPC boundary and Linux
integration modules; a user-level systemd service runs the packaged
BridgeRuntime independently of the window. Shared BridgeRuntime path resolution
makes persistent data portable without changing protocol behavior.

**Tech Stack:** Electron 43.2.0, Electron Vite 5.0.0, React 19.2.8, TypeScript
7.0.2, Vitest 4.1.10, Node's built-in test runner, systemd user services,
electron-builder 26.15.3, Debian packaging.

## Global Constraints

- Target Ubuntu 24.04 x86-64 on the current machine.
- Preserve all existing macOS SwiftUI, Sparkle, and release behavior.
- Keep Companion Voice and Powerhouse product surfaces hidden.
- Never configure, replace, remove, or reset a Tailscale mapping.
- The only allowed Tailscale invocations are `tailscale status --json` and
  `tailscale serve status --json`.
- Pairing output is implemented, but iPhone pairing is manual and outside the
  acceptance test.
- The bridge runs as a user-level systemd service and survives UI exit.
- The renderer has no Node integration and no unrestricted command,
  environment, or filesystem access.
- VoiceClaw config remains `~/.voiceclaw/bridge.json` with mode `0600`.
- Linux bulk state uses XDG data/cache roots; Darwin defaults remain unchanged.
- Linux v1 shows version information but does not install updates.
- Every behavioral change follows a witnessed red-green-refactor cycle.

## File Map

### Shared bridge

- `BridgeRuntime/server/platform-paths.js` — deterministic Darwin/Linux path
  resolution.
- `BridgeRuntime/tests/platform-paths.test.mjs` — platform and override
  contract.
- Existing BridgeRuntime state modules — consume the shared path resolver.

### Linux desktop

- `LinuxCompanion/package.json` and toolchain configuration — Electron Vite,
  React, TypeScript, Vitest, and electron-builder entrypoints.
- `LinuxCompanion/src/shared/contracts.ts` — serializable desktop contracts and
  input validation.
- `LinuxCompanion/src/main/linux/paths.ts` — VoiceClaw-owned Linux paths.
- `LinuxCompanion/src/main/linux/config-store.ts` — atomic config ownership.
- `LinuxCompanion/src/main/linux/command-runner.ts` — explicit `execFile`
  abstraction.
- `LinuxCompanion/src/main/linux/tailscale.ts` — read-only Tailscale
  inspection.
- `LinuxCompanion/src/main/linux/systemd.ts` — unit rendering and exact
  lifecycle calls.
- `LinuxCompanion/src/main/linux/autostart.ts` — owned XDG desktop autostart.
- `LinuxCompanion/service/bridge-entry.mjs` — reads the protected config,
  prepares the bridge environment in memory, and imports BridgeRuntime.
- `LinuxCompanion/src/main/bridge-client.ts` — authenticated loopback API.
- `LinuxCompanion/src/main/companion-controller.ts` — desktop use-case
  orchestration.
- `LinuxCompanion/src/main/ipc.ts` — allow-listed handler registration.
- `LinuxCompanion/src/main/index.ts` — secure window, tray, lifecycle.
- `LinuxCompanion/src/preload/index.ts` — fixed renderer API.
- `LinuxCompanion/src/renderer/` — React application, six sections, styles,
  tests.

### Packaging and verification

- `LinuxCompanion/electron-builder.yml` — Debian target and packaged runtime.
- `LinuxCompanion/scripts/prepare-runtime.mjs` — deterministic runtime manifest
  and production dependency staging.
- `scripts/verify_linux_companion.sh` — package content and launch contract.
- `docs/LINUX.md` and `README.md` — Linux install and safety documentation.

---

### Task 1: Make BridgeRuntime persistent paths platform-aware

**Files:**

- Create: `BridgeRuntime/server/platform-paths.js`
- Create: `BridgeRuntime/tests/platform-paths.test.mjs`
- Modify: `BridgeRuntime/server/artifact-inbox.js`
- Modify: `BridgeRuntime/server/input-attachments.js`
- Modify: `BridgeRuntime/server/route-tasks.js`
- Modify: `BridgeRuntime/server/voice-remote-sessions.js`
- Modify: `BridgeRuntime/server/index.js`
- Modify: `BridgeRuntime/server/asr.js`
- Modify: `BridgeRuntime/server/tts.js`
- Modify: `BridgeRuntime/server/hf-realtime-sidecar.js`

**Interfaces:**

- Produces:
  `resolveVoiceClawPaths({ platform, home, env }): VoiceClawPlatformPaths`
- Produces: `PLATFORM_PATHS: VoiceClawPlatformPaths`
- Preserves all existing per-feature environment overrides.

- [ ] **Step 1: Write the failing path contract test**

```js
import assert from 'node:assert/strict';
import test from 'node:test';

import {
  resolveVoiceClawPaths,
} from '../server/platform-paths.js';

test('Linux uses XDG roots for all VoiceClaw bulk state', () => {
  const paths = resolveVoiceClawPaths({
    platform: 'linux',
    home: '/home/tester',
    env: {
      XDG_DATA_HOME: '/data',
      XDG_CACHE_HOME: '/cache',
    },
  });

  assert.equal(paths.appSupportDir, '/data/voiceclaw-companion');
  assert.equal(paths.realtimeAppSupportDir, '/data/voiceclaw-companion');
  assert.equal(paths.cacheDir, '/cache/voiceclaw-companion');
  assert.equal(paths.artifactInboxDir, '/data/voiceclaw-companion/Artifact Inbox');
  assert.equal(paths.inputAttachmentsDir, '/data/voiceclaw-companion/Input Attachments');
  assert.equal(paths.routeTasksStatePath, '/data/voiceclaw-companion/route-tasks.json');
  assert.equal(paths.voiceRemoteSessionsStatePath, '/data/voiceclaw-companion/voice-remote-sessions.json');
  assert.equal(paths.logsDir, '/data/voiceclaw-companion/logs');
  assert.equal(paths.modelsDir, '/data/voiceclaw-companion/Models');
});

test('Darwin retains both historical Application Support roots', () => {
  const paths = resolveVoiceClawPaths({
    platform: 'darwin',
    home: '/Users/tester',
    env: {},
  });

  assert.equal(
    paths.appSupportDir,
    '/Users/tester/Library/Application Support/VoiceClaw Companion',
  );
  assert.equal(
    paths.realtimeAppSupportDir,
    '/Users/tester/Library/Application Support/VoiceClaw Realtime Companion',
  );
  assert.equal(
    paths.artifactInboxDir,
    '/Users/tester/Library/Application Support/VoiceClaw Realtime Companion/Artifact Inbox',
  );
  assert.equal(
    paths.voiceRemoteSessionsStatePath,
    '/Users/tester/Library/Application Support/VoiceClaw Companion/voice-remote-sessions.json',
  );
});

test('explicit VoiceClaw roots override platform defaults', () => {
  const paths = resolveVoiceClawPaths({
    platform: 'linux',
    home: '/home/tester',
    env: {
      VOICECLAW_APP_SUPPORT_DIR: '/owned/data',
      VOICECLAW_CACHE_DIR: '/owned/cache',
      VOICECLAW_MODEL_DIR: '/owned/models',
    },
  });

  assert.equal(paths.appSupportDir, '/owned/data');
  assert.equal(paths.realtimeAppSupportDir, '/owned/data');
  assert.equal(paths.cacheDir, '/owned/cache');
  assert.equal(paths.modelsDir, '/owned/models');
});
```

- [ ] **Step 2: Run the test and witness RED**

Run:

```sh
cd BridgeRuntime
node --test tests/platform-paths.test.mjs
```

Expected: FAIL with `ERR_MODULE_NOT_FOUND` for
`server/platform-paths.js`.

- [ ] **Step 3: Implement the shared resolver**

```js
import { homedir } from 'node:os';
import { join } from 'node:path';

export function resolveVoiceClawPaths({
  platform = process.platform,
  home = homedir(),
  env = process.env,
} = {}) {
  const linuxDataRoot = env.XDG_DATA_HOME || join(home, '.local', 'share');
  const linuxCacheRoot = env.XDG_CACHE_HOME || join(home, '.cache');
  const darwinAppSupport = join(
    home,
    'Library',
    'Application Support',
    'VoiceClaw Companion',
  );
  const darwinRealtimeAppSupport = join(
    home,
    'Library',
    'Application Support',
    'VoiceClaw Realtime Companion',
  );
  const appSupportDir = env.VOICECLAW_APP_SUPPORT_DIR
    || (platform === 'darwin'
      ? darwinAppSupport
      : join(linuxDataRoot, 'voiceclaw-companion'));
  const realtimeAppSupportDir = env.VOICECLAW_APP_SUPPORT_DIR
    || (platform === 'darwin'
      ? darwinRealtimeAppSupport
      : appSupportDir);
  const cacheDir = env.VOICECLAW_CACHE_DIR
    || (platform === 'darwin'
      ? darwinAppSupport
      : join(linuxCacheRoot, 'voiceclaw-companion'));
  const modelsDir = env.VOICECLAW_MODEL_DIR
    || join(realtimeAppSupportDir, 'Models');

  return Object.freeze({
    appSupportDir,
    realtimeAppSupportDir,
    cacheDir,
    artifactInboxDir: join(realtimeAppSupportDir, 'Artifact Inbox'),
    inputAttachmentsDir: join(realtimeAppSupportDir, 'Input Attachments'),
    routeTasksStatePath: join(realtimeAppSupportDir, 'route-tasks.json'),
    voiceRemoteSessionsStatePath: join(appSupportDir, 'voice-remote-sessions.json'),
    logsDir: join(appSupportDir, 'logs'),
    modelsDir,
    piperModelsDir: join(modelsDir, 'piper'),
  });
}

export const PLATFORM_PATHS = resolveVoiceClawPaths();
```

Update each consumer to import `PLATFORM_PATHS` and use these exact defaults:

```js
// artifact-inbox.js
const DEFAULT_ROOT = PLATFORM_PATHS.artifactInboxDir;

// input-attachments.js
const DEFAULT_ROOT = PLATFORM_PATHS.inputAttachmentsDir;

// route-tasks.js
const DEFAULT_STATE_PATH = PLATFORM_PATHS.routeTasksStatePath;

// voice-remote-sessions.js
const DEFAULT_STATE_PATH = PLATFORM_PATHS.voiceRemoteSessionsStatePath;

// index.js
const DEFAULT_APP_SUPPORT_DIR = PLATFORM_PATHS.appSupportDir;

// asr.js
const VOICECLAW_MODEL_DIR = PLATFORM_PATHS.modelsDir;

// tts.js
const VOICECLAW_PIPER_MODEL_DIR = PLATFORM_PATHS.piperModelsDir;

// hf-realtime-sidecar.js
const HF_LOG_DIR = process.env.VOICECLAW_HF_LOG_DIR || PLATFORM_PATHS.logsDir;
```

Remove only the imports made unused by those replacements.

- [ ] **Step 4: Run focused and full bridge verification**

Run:

```sh
cd BridgeRuntime
node --test tests/platform-paths.test.mjs
npm test
```

Expected: the three new tests PASS and the existing suite reports zero
failures.

- [ ] **Step 5: Commit**

```sh
git add BridgeRuntime/server BridgeRuntime/tests/platform-paths.test.mjs
git commit -m "feat: add Linux runtime data paths"
```

---

### Task 2: Bootstrap the Electron project and freeze shared contracts

**Files:**

- Create: `LinuxCompanion/package.json`
- Create: `LinuxCompanion/package-lock.json`
- Create: `LinuxCompanion/electron.vite.config.ts`
- Create: `LinuxCompanion/tsconfig.json`
- Create: `LinuxCompanion/tsconfig.node.json`
- Create: `LinuxCompanion/vitest.config.ts`
- Create: `LinuxCompanion/src/test/setup.ts`
- Create: `LinuxCompanion/src/shared/contracts.ts`
- Create: `LinuxCompanion/src/shared/contracts.test.ts`
- Modify: `.gitignore`

**Interfaces:**

- Produces: `SetupInput`, `BridgeConfig`, `PublicBridgeConfig`, `StatusItem`, `ServiceStatus`,
  `TailscaleStatus`, `RouteTaskSummary`, `ArtifactSummary`,
  `CompanionSnapshot`, `PairingOptions`, `VoiceClawDesktopAPI`.
- Produces: `normalizeSetupInput(value): SetupInput`.

- [ ] **Step 1: Add only the toolchain configuration**

Use this `package.json`:

```json
{
  "name": "voiceclaw-linux-companion",
  "version": "0.1.0",
  "private": true,
  "type": "module",
  "main": "./out/main/index.js",
  "scripts": {
    "dev": "electron-vite dev",
    "test": "vitest run",
    "test:watch": "vitest",
    "lint": "tsc --noEmit -p tsconfig.json && tsc --noEmit -p tsconfig.node.json",
    "build": "npm run lint && electron-vite build",
    "smoke:electron": "npm run build && xvfb-run -a electron . --smoke-test",
    "package:deb": "npm run build && node scripts/prepare-runtime.mjs && electron-builder --linux deb --x64"
  },
  "dependencies": {
    "qrcode": "1.5.4",
    "react": "19.2.8",
    "react-dom": "19.2.8"
  },
  "devDependencies": {
    "@testing-library/jest-dom": "7.0.0",
    "@testing-library/react": "16.3.2",
    "@testing-library/user-event": "14.6.1",
    "@types/node": "26.1.2",
    "@types/qrcode": "1.5.6",
    "@types/react": "19.2.17",
    "@types/react-dom": "19.2.3",
    "@vitejs/plugin-react": "6.0.5",
    "electron": "43.2.0",
    "electron-builder": "26.15.3",
    "electron-vite": "5.0.0",
    "jsdom": "30.0.1",
    "typescript": "7.0.2",
    "vite": "8.2.0",
    "vitest": "4.1.10"
  }
}
```

Use this Electron Vite configuration:

```ts
import react from '@vitejs/plugin-react';
import { defineConfig, externalizeDepsPlugin } from 'electron-vite';

export default defineConfig({
  main: {
    plugins: [externalizeDepsPlugin()],
  },
  preload: {
    plugins: [externalizeDepsPlugin()],
  },
  renderer: {
    plugins: [react()],
  },
});
```

Use this renderer/shared `tsconfig.json`:

```json
{
  "compilerOptions": {
    "target": "ES2023",
    "useDefineForClassFields": true,
    "lib": ["ES2023", "DOM", "DOM.Iterable"],
    "allowJs": false,
    "skipLibCheck": true,
    "esModuleInterop": true,
    "allowSyntheticDefaultImports": true,
    "strict": true,
    "forceConsistentCasingInFileNames": true,
    "module": "ESNext",
    "moduleResolution": "Bundler",
    "resolveJsonModule": true,
    "isolatedModules": true,
    "noEmit": true,
    "jsx": "react-jsx",
    "types": ["vitest/globals", "@testing-library/jest-dom"]
  },
  "include": [
    "src/renderer/**/*.ts",
    "src/renderer/**/*.tsx",
    "src/shared/**/*.ts",
    "src/test/**/*.ts"
  ]
}
```

Use this `tsconfig.node.json`:

```json
{
  "compilerOptions": {
    "target": "ES2023",
    "lib": ["ES2023"],
    "strict": true,
    "skipLibCheck": true,
    "module": "ESNext",
    "moduleResolution": "Bundler",
    "resolveJsonModule": true,
    "isolatedModules": true,
    "noEmit": true,
    "types": ["node", "electron", "vitest/globals"]
  },
  "include": [
    "electron.vite.config.ts",
    "vitest.config.ts",
    "src/main/**/*.ts",
    "src/preload/**/*.ts",
    "src/shared/**/*.ts"
  ]
}
```

Use this `vitest.config.ts`:

```ts
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  plugins: [react()],
  test: {
    environment: 'jsdom',
    setupFiles: ['./src/test/setup.ts'],
    clearMocks: true,
    restoreMocks: true,
  },
});
```

Main/preload tests start with `// @vitest-environment node`.
`src/test/setup.ts` contains:

```ts
import '@testing-library/jest-dom/vitest';
```

Run:

```sh
cd LinuxCompanion
npm install
```

Add these ignore entries:

```gitignore
LinuxCompanion/node_modules/
LinuxCompanion/out/
LinuxCompanion/dist/
```

- [ ] **Step 2: Write the failing shared-contract tests**

```ts
import { describe, expect, it } from 'vitest';

import { normalizeSetupInput } from './contracts';

describe('normalizeSetupInput', () => {
  it('normalizes a valid Linux setup request', () => {
    expect(normalizeSetupInput({
      port: '12321',
      openClawInstallPath: ' /home/michael/.openclaw ',
      openClawAgentName: ' main ',
      realtimeAuthMode: 'openclaw-oauth',
      realtimeAuthFallbackToAPIKey: false,
      openAIAPIKey: '',
    })).toEqual({
      port: 12321,
      openClawInstallPath: '/home/michael/.openclaw',
      openClawAgentName: 'main',
      realtimeAuthMode: 'openclaw-oauth',
      realtimeAuthFallbackToAPIKey: false,
      openAIAPIKey: '',
    });
  });

  it.each([0, 65536, 'abc'])('rejects invalid bridge port %s', (port) => {
    expect(() => normalizeSetupInput({
      port,
      openClawInstallPath: '/home/michael/.openclaw',
      openClawAgentName: 'main',
      realtimeAuthMode: 'openclaw-oauth',
      realtimeAuthFallbackToAPIKey: false,
      openAIAPIKey: '',
    })).toThrow('Bridge port must be an integer from 1 through 65535.');
  });

  it('rejects agent identifiers with control characters', () => {
    expect(() => normalizeSetupInput({
      port: 12321,
      openClawInstallPath: '/home/michael/.openclaw',
      openClawAgentName: 'main\nother',
      realtimeAuthMode: 'api-key',
      realtimeAuthFallbackToAPIKey: true,
      openAIAPIKey: 'sk-test',
    })).toThrow('OpenClaw agent is invalid.');
  });
});
```

- [ ] **Step 3: Run the test and witness RED**

Run:

```sh
cd LinuxCompanion
npm test -- src/shared/contracts.test.ts
```

Expected: FAIL because `contracts.ts` does not exist.

- [ ] **Step 4: Implement contracts and validation**

Define these stable contracts:

```ts
export type ReadinessState =
  | 'ready'
  | 'working'
  | 'warning'
  | 'needs_action'
  | 'blocked'
  | 'unavailable'
  | 'idle';

export interface SetupInput {
  port: number;
  openClawInstallPath: string;
  openClawAgentName: string;
  realtimeAuthMode: 'api-key' | 'openclaw-oauth';
  realtimeAuthFallbackToAPIKey: boolean;
  openAIAPIKey: string;
}

export interface BridgeConfig extends SetupInput {
  gatewayToken: string;
  tailscaleDNSName: string;
  tailscaleBaseURL: string;
}

export interface PublicBridgeConfig
  extends Omit<SetupInput, 'openAIAPIKey'> {
  hasOpenAIAPIKey: boolean;
}

export interface StatusItem {
  id: string;
  label: string;
  state: ReadinessState;
  summary: string;
  detail: string;
  action?: string;
  path?: string;
}

export interface ServiceStatus {
  installed: boolean;
  enabled: boolean;
  active: boolean;
  loadState: string;
  activeState: string;
  subState: string;
  summary: string;
}

export interface TailscaleStatus {
  installed: boolean;
  connected: boolean;
  dnsName: string;
  serveURL: string;
  serveMapped: boolean;
  summary: string;
}

export interface RouteTaskSummary {
  taskID: string;
  state: string;
  runtime: string;
  route: string;
  progress: string;
  result: string;
  error: string;
  updatedAt: number;
}

export interface ArtifactSummary {
  artifactID: string;
  taskID: string;
  displayName: string;
  contentType: string;
  byteCount: number;
  sha256: string;
  createdAt: number;
}

export interface PairingOptions {
  includeOpenAIAPIKey: boolean;
  includeCerebrasAPIKey: boolean;
  includeBridgeCredentials: boolean;
  includeChatGPTOAuth: boolean;
}

export interface CompanionSnapshot {
  config: PublicBridgeConfig;
  service: ServiceStatus;
  tailscale: TailscaleStatus;
  access: StatusItem[];
  diagnostics: StatusItem[];
  tasks: RouteTaskSummary[];
  artifacts: ArtifactSummary[];
  pairingAvailable: boolean;
  checkedAt: number;
}

export interface VoiceClawDesktopAPI {
  getSnapshot(): Promise<CompanionSnapshot>;
  installAndStart(input: SetupInput): Promise<CompanionSnapshot>;
  restartBridge(): Promise<CompanionSnapshot>;
  resetBridge(confirmed: true): Promise<CompanionSnapshot>;
  suggestPort(): Promise<number>;
  setLaunchAtLogin(enabled: boolean): Promise<boolean>;
  getPairingPayload(options: PairingOptions): Promise<Record<string, unknown>>;
  deleteArtifact(artifactID: string): Promise<CompanionSnapshot>;
  emptyArtifactInbox(): Promise<CompanionSnapshot>;
  copyText(value: string): Promise<void>;
  openPath(path: string): Promise<void>;
  openURL(url: string): Promise<void>;
}
```

Implement `normalizeSetupInput` with numeric port bounds, non-empty absolute
OpenClaw path, an agent maximum of 128 characters without control characters,
the two allowed auth modes, and boolean normalization without coercing strings.

- [ ] **Step 5: Run tests and type checks**

Run:

```sh
cd LinuxCompanion
npm test -- src/shared/contracts.test.ts
npm run lint
```

Expected: three tests PASS and both TypeScript configurations exit zero.

- [ ] **Step 6: Commit**

```sh
git add .gitignore LinuxCompanion
git commit -m "build: bootstrap Linux Electron companion"
```

---

### Task 3: Add atomic Linux config ownership

**Files:**

- Create: `LinuxCompanion/src/main/linux/paths.ts`
- Create: `LinuxCompanion/src/main/linux/config-store.ts`
- Create: `LinuxCompanion/src/main/linux/config-store.test.ts`

**Interfaces:**

- Produces:
  `linuxPaths({ home, env }): LinuxOwnedPaths`
- Produces:
  `ConfigStore.read(): Promise<BridgeConfig>`
- Produces:
  `ConfigStore.write(input: SetupInput): Promise<BridgeConfig>`
- Produces:
  `ConfigStore.updateNetwork(dnsName: string, baseURL: string): Promise<BridgeConfig>`
- Produces:
  `ConfigStore.remove(): Promise<void>`

- [ ] **Step 1: Write failing ownership tests**

Use a `mkdtemp` fixture and assert:

```ts
it('writes config atomically with mode 0600 and preserves the gateway token', async () => {
  const store = new ConfigStore(paths);
  const first = await store.write(validSetup);
  const second = await store.write({ ...validSetup, port: 23456 });
  const stat = await fs.stat(paths.configFile);
  const stored = JSON.parse(await fs.readFile(paths.configFile, 'utf8'));

  expect(stat.mode & 0o777).toBe(0o600);
  expect(first.gatewayToken).toMatch(/^[A-Za-z0-9_-]{43}$/);
  expect(second.gatewayToken).toBe(first.gatewayToken);
  expect(stored.port).toBe(23456);
  expect(await pathExists(`${paths.configFile}.tmp`)).toBe(false);
});

it('uses only VoiceClaw-owned XDG and compatibility paths', () => {
  expect(linuxPaths({
    home: '/home/tester',
    env: {
      XDG_CONFIG_HOME: '/config',
      XDG_DATA_HOME: '/data',
      XDG_CACHE_HOME: '/cache',
    },
  })).toEqual({
    configDir: '/home/tester/.voiceclaw',
    configFile: '/home/tester/.voiceclaw/bridge.json',
    systemdDir: '/config/systemd/user',
    unitFile: '/config/systemd/user/voiceclaw-companion-bridge.service',
    autostartDir: '/config/autostart',
    autostartFile: '/config/autostart/voiceclaw-companion.desktop',
    dataDir: '/data/voiceclaw-companion',
    cacheDir: '/cache/voiceclaw-companion',
  });
});

it('removes only the exact compatibility config file', async () => {
  await store.write(validSetup);
  await fs.writeFile(join(paths.configDir, 'keep.txt'), 'keep');
  await store.remove();
  expect(await pathExists(paths.configFile)).toBe(false);
  expect(await fs.readFile(join(paths.configDir, 'keep.txt'), 'utf8')).toBe('keep');
});

it('updates only validated Tailscale pairing fields', async () => {
  const before = await store.write(validSetup);
  const after = await store.updateNetwork(
    'openclaw.tailnet.ts.net',
    'https://openclaw.tailnet.ts.net:12321',
  );
  expect(after.gatewayToken).toBe(before.gatewayToken);
  expect(after.tailscaleDNSName).toBe('openclaw.tailnet.ts.net');
  expect(after.tailscaleBaseURL).toBe('https://openclaw.tailnet.ts.net:12321');
  await expect(store.updateNetwork('bad\nname', 'https://example.test'))
    .rejects.toThrow('Tailscale DNS name is invalid.');
});
```

- [ ] **Step 2: Run the tests and witness RED**

Run:

```sh
cd LinuxCompanion
npm test -- src/main/linux/config-store.test.ts
```

Expected: FAIL because `paths.ts` and `config-store.ts` do not exist.

- [ ] **Step 3: Implement exact path and config behavior**

`linuxPaths` uses `~/.voiceclaw` for compatibility config,
`${XDG_CONFIG_HOME:-~/.config}` for systemd/autostart,
`${XDG_DATA_HOME:-~/.local/share}/voiceclaw-companion` for data, and
`${XDG_CACHE_HOME:-~/.cache}/voiceclaw-companion` for cache.

`ConfigStore.write` must:

```ts
const existing = await this.readRaw().catch(() => ({}));
const next: BridgeConfig = {
  ...normalizeSetupInput(input),
  openAIAPIKey: String(input.openAIAPIKey || '').trim()
    || String(existing.openAIAPIKey || ''),
  gatewayToken: validToken(existing.gatewayToken)
    ? existing.gatewayToken
    : randomBytes(32).toString('base64url'),
  tailscaleDNSName: String(existing.tailscaleDNSName || ''),
  tailscaleBaseURL: String(existing.tailscaleBaseURL || ''),
};
await mkdir(this.paths.configDir, { recursive: true, mode: 0o700 });
await writeFile(tempFile, `${JSON.stringify(next, null, 2)}\n`, {
  encoding: 'utf8',
  mode: 0o600,
});
await chmod(tempFile, 0o600);
await rename(tempFile, this.paths.configFile);
return next;
```

`read` returns a normalized default using port `12321`,
`~/.openclaw`, agent `main`, auth mode `openclaw-oauth`, fallback `false`, and
an empty API key when no config exists. An empty key submitted later preserves
the existing stored key. It never logs file contents.

`updateNetwork` accepts an empty pair or a newline-free DNS name plus an
`https:` URL whose host matches that DNS name. It reuses the same atomic writer,
preserves every non-network field, and rejects any other URL scheme.

- [ ] **Step 4: Run tests**

Run:

```sh
cd LinuxCompanion
npm test -- src/main/linux/config-store.test.ts
npm run lint
```

Expected: all config tests PASS.

- [ ] **Step 5: Commit**

```sh
git add LinuxCompanion/src/main/linux
git commit -m "feat: add safe Linux companion config"
```

---

### Task 4: Enforce read-only Tailscale inspection

**Files:**

- Create: `LinuxCompanion/src/main/linux/command-runner.ts`
- Create: `LinuxCompanion/src/main/linux/tailscale.ts`
- Create: `LinuxCompanion/src/main/linux/tailscale.test.ts`

**Interfaces:**

- Produces:
  `CommandRunner.run(executable, args, options): Promise<CommandResult>`
- Produces:
  `TailscaleInspector.status(port): Promise<TailscaleStatus>`
- The Tailscale class exposes no mutation method.

- [ ] **Step 1: Write failing read-only tests**

```ts
it('uses exactly the two approved read-only Tailscale commands', async () => {
  const calls: Array<[string, string[]]> = [];
  const runner = fakeRunner(calls, {
    'status --json': JSON.stringify({
      BackendState: 'Running',
      Self: { DNSName: 'openclaw.tailnet.ts.net.' },
    }),
    'serve status --json': JSON.stringify({
      Web: {
        'openclaw.tailnet.ts.net:12321': {
          Handlers: { '/': { Proxy: 'http://127.0.0.1:12321' } },
        },
      },
    }),
  });

  const status = await new TailscaleInspector(runner).status(12321);

  expect(calls).toEqual([
    ['tailscale', ['status', '--json']],
    ['tailscale', ['serve', 'status', '--json']],
  ]);
  expect(status.connected).toBe(true);
  expect(status.serveMapped).toBe(true);
  expect(status.serveURL).toBe('https://openclaw.tailnet.ts.net:12321');
});

it('treats missing Tailscale as a warning without a repair attempt', async () => {
  const calls: Array<[string, string[]]> = [];
  const runner = failingRunner(calls, { code: 'ENOENT' });
  const status = await new TailscaleInspector(runner).status(12321);

  expect(calls).toEqual([['tailscale', ['status', '--json']]]);
  expect(status.installed).toBe(false);
  expect(status.summary).toBe('Tailscale CLI is not available.');
});

it('contains no mutating Tailscale command vocabulary', async () => {
  const source = await fs.readFile(new URL('./tailscale.ts', import.meta.url), 'utf8');
  expect(source).not.toMatch(/\[['"](?:up|down|set|reset)['"]/);
  expect(source).not.toMatch(/\[['"]serve['"],\s*['"](?:--yes|reset|https)['"]/);
});
```

- [ ] **Step 2: Run the tests and witness RED**

Run:

```sh
cd LinuxCompanion
npm test -- src/main/linux/tailscale.test.ts
```

Expected: FAIL because the inspector does not exist.

- [ ] **Step 3: Implement explicit command execution and parsing**

`command-runner.ts` wraps `execFile` with:

```ts
export interface CommandResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

export interface CommandRunner {
  run(
    executable: string,
    args: readonly string[],
    options?: { timeoutMs?: number; env?: NodeJS.ProcessEnv },
  ): Promise<CommandResult>;
}
```

It enforces a timeout, caps each output stream at 256 KiB, and returns bounded
stderr on nonzero exit without invoking a shell.

`TailscaleInspector.status` calls `status --json` first. It calls
`serve status --json` only when the CLI exists, parses an exact selected-port
proxy to `http://127.0.0.1:<port>`, strips the DNS trailing dot, and returns a
warning for missing or malformed state.

- [ ] **Step 4: Run tests and scan the implementation**

Run:

```sh
cd LinuxCompanion
npm test -- src/main/linux/tailscale.test.ts
rg -n "tailscale.*(up|down|set|reset|--yes)" src || true
```

Expected: tests PASS and the scan returns no implementation hit.

- [ ] **Step 5: Commit**

```sh
git add LinuxCompanion/src/main/linux
git commit -m "feat: add read-only Tailscale status"
```

---

### Task 5: Implement systemd service and XDG autostart ownership

**Files:**

- Create: `LinuxCompanion/src/main/linux/systemd.ts`
- Create: `LinuxCompanion/src/main/linux/systemd.test.ts`
- Create: `LinuxCompanion/src/main/linux/autostart.ts`
- Create: `LinuxCompanion/src/main/linux/autostart.test.ts`
- Create: `LinuxCompanion/service/bridge-entry.mjs`
- Create: `LinuxCompanion/service/bridge-entry.test.mjs`

**Interfaces:**

- Consumes: `CommandRunner`, `LinuxOwnedPaths`.
- Produces:
  `renderBridgeUnit(launch): string`
- Produces:
  `SystemdService.installAndStart(launch): Promise<ServiceStatus>`
- Produces:
  `SystemdService.restart(): Promise<ServiceStatus>`
- Produces:
  `SystemdService.status(): Promise<ServiceStatus>`
- Produces:
  `SystemdService.logTail(lines): Promise<string>`
- Produces:
  `AutostartStore.setEnabled(enabled, executablePath): Promise<boolean>`
- Produces:
  `environmentFromConfig(config, paths): NodeJS.ProcessEnv`

- [ ] **Step 1: Write failing unit and lifecycle tests**

```ts
it('renders an exact user service using Electron embedded Node', () => {
  expect(renderBridgeUnit({
    executablePath: '/opt/VoiceClaw Companion/voiceclaw-companion',
    serviceEntryPath: '/opt/VoiceClaw Companion/resources/service/bridge-entry.mjs',
    configFile: '/home/tester/.voiceclaw/bridge.json',
    dataDir: '/home/tester/.local/share/voiceclaw-companion',
    cacheDir: '/home/tester/.cache/voiceclaw-companion',
  })).toBe(`[Unit]
Description=VoiceClaw Companion Bridge
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
Environment=ELECTRON_RUN_AS_NODE=1
Environment=VOICECLAW_CONFIG_PATH=/home/tester/.voiceclaw/bridge.json
Environment=VOICECLAW_APP_SUPPORT_DIR=/home/tester/.local/share/voiceclaw-companion
Environment=VOICECLAW_CACHE_DIR=/home/tester/.cache/voiceclaw-companion
WorkingDirectory=/home/tester/.local/share/voiceclaw-companion
UMask=0077
ExecStart="/opt/VoiceClaw Companion/voiceclaw-companion" "/opt/VoiceClaw Companion/resources/service/bridge-entry.mjs"
Restart=on-failure
RestartSec=3

[Install]
WantedBy=default.target
`);
});

it('installs and starts only the exact VoiceClaw user unit', async () => {
  await service.installAndStart(launch);
  expect(calls).toEqual([
    ['systemctl', ['--user', 'daemon-reload']],
    ['systemctl', ['--user', 'enable', '--now', 'voiceclaw-companion-bridge.service']],
    ['systemctl', [
      '--user',
      'show',
      'voiceclaw-companion-bridge.service',
      '--property=LoadState,UnitFileState,ActiveState,SubState',
      '--no-pager',
    ]],
  ]);
});

it('returns a bounded redacted journal tail', async () => {
  const output = await service.logTail(120);
  expect(calls.at(-1)).toEqual([
    'journalctl',
    [
      '--user',
      '--unit=voiceclaw-companion-bridge.service',
      '--no-pager',
      '--lines=120',
      '--output=short-iso',
    ],
  ]);
  expect(output).not.toContain('sk-secret');
  expect(output.length).toBeLessThanOrEqual(64 * 1024);
});
```

Autostart tests require exact creation/removal of
`voiceclaw-companion.desktop`, mode `0644`, and preservation of neighboring
files.

The service-entry test imports `environmentFromConfig` without starting the
bridge and requires:

```js
assert.deepEqual(environmentFromConfig({
  port: 12321,
  gatewayToken: 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
  openClawInstallPath: '/home/tester/.openclaw',
  openClawAgentName: 'main',
}, {
  configFile: '/home/tester/.voiceclaw/bridge.json',
  dataDir: '/home/tester/.local/share/voiceclaw-companion',
  cacheDir: '/home/tester/.cache/voiceclaw-companion',
  home: '/home/tester',
}), {
  VB_PORT: '12321',
  VB_BIND_HOST: '127.0.0.1',
  VOICECLAW_BRIDGE_TOKEN: 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
  VOICECLAW_CONFIG_PATH: '/home/tester/.voiceclaw/bridge.json',
  VOICECLAW_CONFIG: '/home/tester/.voiceclaw/bridge.json',
  VOICECLAW_APP_SUPPORT_DIR: '/home/tester/.local/share/voiceclaw-companion',
  VOICECLAW_CACHE_DIR: '/home/tester/.cache/voiceclaw-companion',
  REALTIME_LOG_DIR: '/home/tester/.local/share/voiceclaw-companion/logs',
  OPENCLAW_CONFIG: '/home/tester/.openclaw/openclaw.json',
  OPENCLAW_INSTALL_PATH: '/home/tester/.openclaw',
  INTERCOM_AGENT: 'main',
  OPENCLAW_AGENT: 'main',
  VOICECLAW_POWERHOUSE_BOOT_PREWARM: 'false',
  COMPANION_VOICE_QWEN_PREWARM: 'false',
  COMPANION_VOICE_TTS_PREWARM: 'false',
  COMPANION_VOICE_HF_PREWARM: 'false',
  COMPANION_VOICE_HF_KEEPHOT: 'false',
});
```

- [ ] **Step 2: Run tests and witness RED**

Run:

```sh
cd LinuxCompanion
npm test -- src/main/linux/systemd.test.ts src/main/linux/autostart.test.ts
node --test service/bridge-entry.test.mjs
```

Expected: FAIL because service, autostart, and bridge-entry modules do not
exist.

- [ ] **Step 3: Implement safe lifecycle behavior**

Use the exact unit text in the test. Reject newline, NUL, and quote characters
in launch paths before rendering.

`bridge-entry.mjs` reads only `VOICECLAW_CONFIG_PATH`, verifies that the JSON is
an object with a valid port, a 32-byte base64url gateway token, absolute
OpenClaw path, and valid agent name, applies `environmentFromConfig` to
`process.env`, prepends `~/.local/bin`, `/usr/local/bin`, `/usr/bin`, and `/bin`
to `PATH`, and then dynamically imports
`../BridgeRuntime/server/index.js`. Guard the import/launch path so importing
the helper in its test does not start the bridge.

Parse `systemctl show` key-value output into `ServiceStatus`; do not infer
`active` from process listings. Restart calls only:

```ts
await runner.run('systemctl', [
  '--user',
  'restart',
  'voiceclaw-companion-bridge.service',
]);
```

The XDG desktop entry is:

```ini
[Desktop Entry]
Type=Application
Name=VoiceClaw Companion
Comment=Open VoiceClaw Companion at login
Exec="/opt/VoiceClaw Companion/voiceclaw-companion"
Terminal=false
Categories=Utility;
X-GNOME-Autostart-enabled=true
```

Only `setEnabled(false)` may remove the exact owned autostart file.

- [ ] **Step 4: Run focused tests**

Run:

```sh
cd LinuxCompanion
npm test -- src/main/linux/systemd.test.ts src/main/linux/autostart.test.ts
node --test service/bridge-entry.test.mjs
npm run lint
```

Expected: systemd, autostart, and bridge-entry tests PASS.

- [ ] **Step 5: Commit**

```sh
git add LinuxCompanion/src/main/linux LinuxCompanion/service
git commit -m "feat: manage Linux companion lifecycle"
```

---

### Task 6: Add the authenticated bridge client and Companion controller

**Files:**

- Create: `LinuxCompanion/src/main/bridge-client.ts`
- Create: `LinuxCompanion/src/main/bridge-client.test.ts`
- Create: `LinuxCompanion/src/main/linux/access-diagnostics.ts`
- Create: `LinuxCompanion/src/main/linux/access-diagnostics.test.ts`
- Create: `LinuxCompanion/src/main/companion-controller.ts`
- Create: `LinuxCompanion/src/main/companion-controller.test.ts`

**Interfaces:**

- Consumes: config, systemd, autostart, Tailscale, `fetch`.
- Produces:
  `BridgeClient.health()`
- Produces:
  `BridgeClient.setupPayload(options)`
- Produces:
  `BridgeClient.tasks()`
- Produces:
  `BridgeClient.artifacts()`
- Produces:
  `BridgeClient.deleteArtifact(id)`
- Produces:
  `BridgeClient.emptyArtifacts()`
- Produces:
  `AccessDiagnostics.check(config, service, bridge): Promise<StatusItem[]>`
- Produces every `VoiceClawDesktopAPI` use case through
  `CompanionController`.

- [ ] **Step 1: Write failing bridge-client tests**

```ts
it('uses no auth for health and bearer auth for protected endpoints', async () => {
  const client = new BridgeClient({
    port: 12321,
    token: 'bridge-token',
    fetch: recordingFetch(responses),
  });

  await client.health();
  await client.tasks();

  expect(requests[0]).toMatchObject({
    url: 'http://127.0.0.1:12321/healthz',
    headers: {},
  });
  expect(requests[1]).toMatchObject({
    url: 'http://127.0.0.1:12321/realtime/tasks?limit=100',
    headers: { Authorization: 'Bearer bridge-token' },
  });
});

it('empties artifacts only after obtaining a fresh confirmation token', async () => {
  await client.emptyArtifacts();
  expect(requests.map((request) => [request.method, request.path])).toEqual([
    ['POST', '/realtime/artifacts/empty-confirmation'],
    ['DELETE', '/realtime/artifacts'],
  ]);
  expect(requests[1].headers['X-VoiceClaw-Empty-Confirmation'])
    .toBe('fresh-confirmation');
});

it('turns timeout and non-JSON failures into bounded desktop errors', async () => {
  await expect(client.tasks()).rejects.toMatchObject({
    code: 'bridge_request_failed',
  });
  expect(String(caughtError.detail).length).toBeLessThanOrEqual(4096);
});
```

- [ ] **Step 2: Write failing access and controller tests**

Cover:

- systemd, config/data/cache/log directory, packaged runtime, local bridge,
  OpenClaw config, Hermes CLI, Codex bridge status, microphone/audio, desktop
  session, and network readiness each produce a stable `StatusItem`;
- audio checks try `pactl info` first and `arecord -l` only when PulseAudio or
  PipeWire status is unavailable;
- the desktop-session check reads `XDG_CURRENT_DESKTOP`,
  `XDG_SESSION_TYPE`, and `DBUS_SESSION_BUS_ADDRESS` without changing them;
- install writes config before unit installation;
- the Tailscale result updates pairing URL fields without invoking a mutation;
- health polling stops after 15 seconds;
- snapshot remains available when bridge, OpenClaw, Hermes, systemd, or
  Tailscale is unavailable;
- suggest-port binds `127.0.0.1` to port `0` and closes the server;
- reset requires an explicit boolean confirmation and targets only owned paths.

Use this ordering assertion:

```ts
expect(events).toEqual([
  'config.write',
  'tailscale.status',
  'config.update-network',
  'systemd.install-and-start',
  'bridge.wait-for-health',
  'snapshot',
]);
```

- [ ] **Step 3: Run tests and witness RED**

Run:

```sh
cd LinuxCompanion
npm test -- \
  src/main/bridge-client.test.ts \
  src/main/linux/access-diagnostics.test.ts \
  src/main/companion-controller.test.ts
```

Expected: FAIL because the client, access diagnostics, and controller are
absent.

- [ ] **Step 4: Implement loopback APIs and orchestration**

Use only these bridge routes:

```text
GET    /healthz
GET    /realtime/status
GET    /realtime/auth/status
GET    /realtime/setup-payload
GET    /realtime/tasks?limit=100
GET    /realtime/artifacts
POST   /realtime/artifacts/empty-confirmation
DELETE /realtime/artifacts
DELETE /realtime/artifacts/:artifactID
```

Pairing query parameters map exactly to:

```ts
const query = new URLSearchParams({
  include_openai_key: options.includeOpenAIAPIKey ? '1' : '0',
  include_cerebras_key: options.includeCerebrasAPIKey ? '1' : '0',
  include_bridge_credentials: options.includeBridgeCredentials ? '1' : '0',
  include_chatgpt_oauth: options.includeChatGPTOAuth ? '1' : '0',
});
```

`CompanionController.getSnapshot` uses `Promise.allSettled` so one unavailable
dependency does not hide the other sections. Every rejected dependency becomes
a `StatusItem` with a safe summary and bounded detail.

Before returning a snapshot, the controller maps `BridgeConfig` to
`PublicBridgeConfig`; it returns `hasOpenAIAPIKey` but never returns
`openAIAPIKey` or `gatewayToken`.

`AccessDiagnostics` uses filesystem `access` calls and the injected
`CommandRunner`. It never invokes a shell, package manager, permission prompt,
or external-runtime mutation. The Hermes check is limited to
`hermes --help`; audio checks are limited to `pactl info` and `arecord -l`.

- [ ] **Step 5: Run controller and bridge tests**

Run:

```sh
cd LinuxCompanion
npm test -- \
  src/main/bridge-client.test.ts \
  src/main/linux/access-diagnostics.test.ts \
  src/main/companion-controller.test.ts
npm run lint
```

Expected: all bridge-client, access, and controller tests PASS.

- [ ] **Step 6: Commit**

```sh
git add LinuxCompanion/src/main
git commit -m "feat: orchestrate Linux companion state"
```

---

### Task 7: Build the secure Electron main, preload, and tray boundary

**Files:**

- Create: `LinuxCompanion/src/main/ipc.ts`
- Create: `LinuxCompanion/src/main/ipc.test.ts`
- Create: `LinuxCompanion/src/main/index.ts`
- Create: `LinuxCompanion/src/main/window-options.ts`
- Create: `LinuxCompanion/src/main/window-options.test.ts`
- Create: `LinuxCompanion/src/preload/index.ts`
- Create: `LinuxCompanion/src/preload/index.test.ts`
- Create: `LinuxCompanion/src/renderer/index.html`
- Create: `LinuxCompanion/src/renderer/src/main.tsx`
- Create: `LinuxCompanion/src/renderer/src/global.d.ts`

**Interfaces:**

- Consumes: `CompanionController`.
- Produces fixed IPC channels for the methods in `VoiceClawDesktopAPI`.
- Produces a secure BrowserWindow and VoiceClaw tray menu.

- [ ] **Step 1: Write failing security-boundary tests**

```ts
it('uses a context-isolated renderer without Node integration', () => {
  const options = companionWindowOptions('/app/preload/index.js');
  expect(options.webPreferences).toMatchObject({
    contextIsolation: true,
    nodeIntegration: false,
    sandbox: true,
    preload: '/app/preload/index.js',
  });
});

it('registers only the fixed VoiceClaw IPC channels', () => {
  registerCompanionIPC(ipc, controller);
  expect([...ipc.channels].sort()).toEqual([
    'voiceclaw:artifacts:delete',
    'voiceclaw:artifacts:empty',
    'voiceclaw:autostart:set',
    'voiceclaw:bridge:install',
    'voiceclaw:bridge:reset',
    'voiceclaw:bridge:restart',
    'voiceclaw:clipboard:copy',
    'voiceclaw:open:path',
    'voiceclaw:open:url',
    'voiceclaw:pairing:get',
    'voiceclaw:port:suggest',
    'voiceclaw:snapshot:get',
  ]);
});

it('preload exposes no generic invoke, send, shell, or filesystem primitive', () => {
  expect(Object.keys(api).sort()).toEqual([
    'copyText',
    'deleteArtifact',
    'emptyArtifactInbox',
    'getPairingPayload',
    'getSnapshot',
    'installAndStart',
    'openPath',
    'openURL',
    'resetBridge',
    'restartBridge',
    'setLaunchAtLogin',
    'suggestPort',
  ]);
});

it('recognizes only the explicit Electron startup smoke flag', () => {
  expect(isElectronSmokeTest(['electron', '.', '--smoke-test'])).toBe(true);
  expect(isElectronSmokeTest(['electron', '.'])).toBe(false);
});
```

- [ ] **Step 2: Run tests and witness RED**

Run:

```sh
cd LinuxCompanion
npm test -- src/main/ipc.test.ts src/main/window-options.test.ts src/preload/index.test.ts
```

Expected: FAIL because the Electron boundary files do not exist.

- [ ] **Step 3: Implement the allow-listed boundary**

Validate every IPC argument again in the main process. Use
`shell.openPath`/`shell.openExternal` only after:

- paths resolve beneath a known VoiceClaw-owned root or the configured
  OpenClaw path;
- URLs use `https:` and match approved help/release destinations.

Create a single main window with minimum size `920x660`. Closing the window
hides it when the tray remains active; **Quit** explicitly exits the desktop
process. The tray menu contains:

```text
Show VoiceClaw Companion
Refresh Status
Copy Phone Setup
Start or Restart Bridge
Bridge: <state>
Quit VoiceClaw Companion
```

The tray never controls Tailscale.

When and only when `--smoke-test` is present, wait for the BrowserWindow
`ready-to-show` event, print `VOICECLAW_ELECTRON_SMOKE_READY`, and exit zero.
A 15-second timer exits nonzero if readiness never arrives.

- [ ] **Step 4: Run boundary tests and build**

Run:

```sh
cd LinuxCompanion
npm test -- src/main/ipc.test.ts src/main/window-options.test.ts src/preload/index.test.ts
npm run build
npm run smoke:electron
```

Expected: boundary tests PASS and Electron Vite emits main, preload, and
renderer output; the Electron startup smoke prints
`VOICECLAW_ELECTRON_SMOKE_READY` and exits zero under Xvfb.

- [ ] **Step 5: Commit**

```sh
git add LinuxCompanion/src
git commit -m "feat: add secure Electron desktop shell"
```

---

### Task 8: Implement the operational React desktop

**Files:**

- Create: `LinuxCompanion/src/renderer/src/App.tsx`
- Create: `LinuxCompanion/src/renderer/src/App.test.tsx`
- Create: `LinuxCompanion/src/renderer/src/use-companion.ts`
- Create: `LinuxCompanion/src/renderer/src/components/AppShell.tsx`
- Create: `LinuxCompanion/src/renderer/src/components/StatusBadge.tsx`
- Create: `LinuxCompanion/src/renderer/src/components/StatusRow.tsx`
- Create: `LinuxCompanion/src/renderer/src/components/ConfirmDialog.tsx`
- Create: `LinuxCompanion/src/renderer/src/screens/SetupScreen.tsx`
- Create: `LinuxCompanion/src/renderer/src/screens/AccessScreen.tsx`
- Create: `LinuxCompanion/src/renderer/src/screens/TasksFilesScreen.tsx`
- Create: `LinuxCompanion/src/renderer/src/screens/PairingScreen.tsx`
- Create: `LinuxCompanion/src/renderer/src/screens/TailscaleScreen.tsx`
- Create: `LinuxCompanion/src/renderer/src/screens/DiagnosticsScreen.tsx`
- Create: `LinuxCompanion/src/renderer/src/styles.css`

**Interfaces:**

- Consumes: `window.voiceclaw`.
- Produces navigation and six operational screens.
- Tasks & Files is read-only in this task; Pair Phone renders a redacted JSON
  preview. Task 9 adds destructive confirmations, QR, and clipboard actions.

- [ ] **Step 1: Write failing renderer behavior tests**

```tsx
it('renders all six navigation destinations', async () => {
  render(<App api={api} />);
  for (const label of [
    'Set Up',
    'Access',
    'Tasks & Files',
    'Pair Phone',
    'Tailscale',
    'Diagnostics',
  ]) {
    expect(await screen.findByRole('button', { name: label })).toBeVisible();
  }
});

it('installs the bridge without offering a Tailscale mutation', async () => {
  const user = userEvent.setup();
  render(<App api={api} />);
  await user.click(await screen.findByRole('button', { name: 'Install and Start' }));
  expect(api.installAndStart).toHaveBeenCalledWith(expect.objectContaining({
    port: 12321,
    openClawInstallPath: '/home/michael/.openclaw',
    openClawAgentName: 'main',
  }));
  expect(screen.queryByRole('button', { name: /configure tailscale/i }))
    .not.toBeInTheDocument();
  expect(screen.queryByRole('button', { name: /reset tailscale/i }))
    .not.toBeInTheDocument();
});

it('keeps diagnostics visible when dependencies are unavailable', async () => {
  render(<App api={apiWithWarnings} />);
  await userEvent.click(screen.getByRole('button', { name: 'Diagnostics' }));
  expect(await screen.findByText('Tailscale CLI is not available.')).toBeVisible();
  expect(screen.getByText('OpenClaw configuration was not found.')).toBeVisible();
});

it('requires confirmation before resetting VoiceClaw-owned Linux state', async () => {
  const user = userEvent.setup();
  render(<App api={api} />);
  await user.click(await screen.findByRole('button', { name: 'Reset Companion State' }));
  expect(api.resetBridge).not.toHaveBeenCalled();
  await user.click(screen.getByRole('button', { name: 'Confirm Reset' }));
  expect(api.resetBridge).toHaveBeenCalledWith(true);
});
```

- [ ] **Step 2: Run tests and witness RED**

Run:

```sh
cd LinuxCompanion
npm test -- src/renderer/src/App.test.tsx
```

Expected: FAIL because the React app does not exist.

- [ ] **Step 3: Implement app state and the six baseline screens**

`useCompanion` owns:

```ts
{
  snapshot: CompanionSnapshot | null;
  selectedSection: 'setup' | 'access' | 'tasks' | 'pairing' | 'tailscale' | 'diagnostics';
  busyAction: string;
  error: string;
  refresh(): Promise<void>;
  install(input: SetupInput): Promise<void>;
  restart(): Promise<void>;
  suggestPort(): Promise<number>;
}
```

Refresh on initial mount and every 30 seconds while the window is visible.
Cancel polling on unmount.

The shell uses a dark navy/slate background, the existing VoiceClaw app icon,
cyan status accents, amber warnings, red destructive controls, clear focus
rings, and responsive content above a minimum 920-by-660 viewport. Every
status color also has a text label.

The Tailscale screen contains read-only cards for installed, connected, DNS,
Serve mapping, and detected URL. Its explanatory callout reads:

```text
This Linux port reads your existing Tailscale state. It never creates,
changes, or removes a Serve mapping.
```

The baseline Tasks & Files screen renders task and artifact metadata without
destructive controls. The baseline Pair Phone screen requests the setup
payload, renders a secret-redacted JSON preview, and exposes the four inclusion
toggles without copying or pairing automatically.

- [ ] **Step 4: Run renderer and accessibility-oriented tests**

Run:

```sh
cd LinuxCompanion
npm test -- src/renderer/src/App.test.tsx
npm run lint
npm run build
```

Expected: renderer tests PASS, type checks pass, and the app builds.

- [ ] **Step 5: Commit**

```sh
git add LinuxCompanion/src/renderer
git commit -m "feat: add Linux companion desktop views"
```

---

### Task 9: Add Tasks & Files and manual pairing

**Files:**

- Modify: `LinuxCompanion/src/renderer/src/screens/TasksFilesScreen.tsx`
- Create: `LinuxCompanion/src/renderer/src/screens/TasksFilesScreen.test.tsx`
- Modify: `LinuxCompanion/src/renderer/src/screens/PairingScreen.tsx`
- Create: `LinuxCompanion/src/renderer/src/screens/PairingScreen.test.tsx`
- Create: `LinuxCompanion/src/renderer/src/pairing.ts`
- Modify: `LinuxCompanion/src/renderer/src/App.tsx`
- Modify: `LinuxCompanion/src/renderer/src/use-companion.ts`

**Interfaces:**

- Consumes: task/artifact snapshot, artifact actions, pairing API.
- Produces:
  `redactedPairingPreview(payload): Record<string, unknown>`
- Produces:
  `setupDeepLink(payload): string`
- Produces QR data URL through `qrcode`.

- [ ] **Step 1: Write failing task and artifact tests**

```tsx
it('shows task state and requires confirmation before deleting an artifact', async () => {
  const user = userEvent.setup();
  render(<TasksFilesScreen snapshot={snapshot} api={api} onRefresh={refresh} />);
  expect(screen.getByText('Codex task')).toBeVisible();
  expect(screen.getByText('report.pdf')).toBeVisible();

  await user.click(screen.getByRole('button', { name: 'Delete report.pdf' }));
  expect(api.deleteArtifact).not.toHaveBeenCalled();
  await user.click(screen.getByRole('button', { name: 'Confirm Delete' }));
  expect(api.deleteArtifact).toHaveBeenCalledWith('artifact-1');
});

it('requires a second confirmation for Empty Inbox', async () => {
  const user = userEvent.setup();
  render(<TasksFilesScreen snapshot={snapshot} api={api} onRefresh={refresh} />);
  await user.click(screen.getByRole('button', { name: 'Empty Inbox' }));
  expect(api.emptyArtifactInbox).not.toHaveBeenCalled();
  await user.click(screen.getByRole('button', { name: 'Confirm Empty Inbox' }));
  expect(api.emptyArtifactInbox).toHaveBeenCalledOnce();
});
```

- [ ] **Step 2: Write failing pairing and redaction tests**

```ts
it('redacts all supported secret aliases without changing the source', () => {
  const payload = {
    OpenAIAPIKey: 'sk-secret',
    gatewayToken: 'bridge-secret',
    ChatGPTOAuthAccessToken: 'oauth-secret',
    TailscaleBaseURL: 'https://host.tailnet.ts.net:12321',
  };
  expect(redactedPairingPreview(payload)).toEqual({
    OpenAIAPIKey: '••••••••',
    gatewayToken: '••••••••',
    ChatGPTOAuthAccessToken: '••••••••',
    TailscaleBaseURL: 'https://host.tailnet.ts.net:12321',
  });
  expect(payload.OpenAIAPIKey).toBe('sk-secret');
});

it('shows QR, JSON, and deep-link copy controls without pairing automatically', async () => {
  render(<PairingScreen api={api} pairingAvailable />);
  expect(await screen.findByAltText('VoiceClaw phone setup QR code')).toBeVisible();
  expect(screen.getByRole('button', { name: 'Copy Setup JSON' })).toBeVisible();
  expect(screen.getByRole('button', { name: 'Copy Setup Link' })).toBeVisible();
  expect(screen.queryByRole('button', { name: /pair iphone now/i }))
    .not.toBeInTheDocument();
});
```

- [ ] **Step 3: Run tests and witness RED**

Run:

```sh
cd LinuxCompanion
npm test -- \
  src/renderer/src/screens/TasksFilesScreen.test.tsx \
  src/renderer/src/screens/PairingScreen.test.tsx
```

Expected: FAIL because both screens and pairing helpers are absent.

- [ ] **Step 4: Implement tasks, artifacts, pairing, and clipboard actions**

Task rows show runtime, route, state, progress, result, error, and updated time.
Artifact rows show display name, content type, formatted size, task ID, SHA-256,
and created time.

Pairing defaults are:

```ts
{
  includeOpenAIAPIKey: false,
  includeCerebrasAPIKey: false,
  includeBridgeCredentials: true,
  includeChatGPTOAuth: true,
}
```

Generate a QR code from the setup deep link, use the redacted object only for
the visible preview, and copy the unredacted payload only after the explicit
inclusion toggles define it. Clipboard writes occur in the main process through
a fixed `copyText` IPC method added to `VoiceClawDesktopAPI`; do not expose the
Electron clipboard module directly.

- [ ] **Step 5: Run UI and full LinuxCompanion tests**

Run:

```sh
cd LinuxCompanion
npm test
npm run lint
npm run build
```

Expected: all renderer and main tests PASS and the app builds.

- [ ] **Step 6: Commit**

```sh
git add LinuxCompanion/src
git commit -m "feat: add Linux tasks files and pairing"
```

---

### Task 10: Package, document, install, and verify on Ubuntu

**Files:**

- Create: `LinuxCompanion/electron-builder.yml`
- Create: `LinuxCompanion/scripts/prepare-runtime.mjs`
- Create: `LinuxCompanion/scripts/prepare-runtime.test.mjs`
- Create: `LinuxCompanion/scripts/smoke-installed.mjs`
- Create: `scripts/verify_linux_companion.sh`
- Create: `docs/LINUX.md`
- Modify: `README.md`
- Modify: `.gitignore`

**Interfaces:**

- Produces:
  `LinuxCompanion/dist/voiceclaw-companion_<version>_amd64.deb`
- Packages BridgeRuntime with production dependencies and a generated manifest.
- Verifies the Debian package without Tailscale mutation.

- [ ] **Step 1: Write the failing runtime-staging test**

```js
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { buildRuntimeManifest } from './prepare-runtime.mjs';

test('builds a deterministic Linux runtime manifest', async () => {
  const root = await mkdtemp(join(tmpdir(), 'voiceclaw-linux-runtime-'));
  await writeFile(join(root, 'server.js'), 'console.log("bridge");\n');
  const manifest = await buildRuntimeManifest({
    runtimeRoot: root,
    version: '0.1.0',
    build: '202607300001',
    sourceCommit: '0123456789abcdef',
    files: ['server.js'],
  });

  assert.equal(manifest.product, 'VoiceClaw Companion');
  assert.equal(manifest.version, '0.1.0');
  assert.equal(manifest.build, '202607300001');
  assert.equal(manifest.entryPoint, 'server/index.js');
  assert.match(manifest.runtimeHash, /^[a-f0-9]{64}$/);
  assert.equal(manifest.sourceCommit, '0123456789abcdef');
});
```

- [ ] **Step 2: Run the staging test and witness RED**

Run:

```sh
cd LinuxCompanion
node --test scripts/prepare-runtime.test.mjs
```

Expected: FAIL because `prepare-runtime.mjs` does not exist.

- [ ] **Step 3: Implement staging and electron-builder configuration**

`prepare-runtime.mjs` must:

1. run `npm ci --omit=dev` in `../BridgeRuntime`;
2. copy BridgeRuntime into
   `LinuxCompanion/build-resources/BridgeRuntime`;
3. exclude `tests`, `.git`, and temporary logs;
4. hash sorted relative file paths plus bytes while excluding the generated
   `runtime-manifest.json`;
5. write `runtime-manifest.json` with product, version, numeric build, runtime
   package version, hash, entrypoint, generation timestamp, and source commit.

Export `buildRuntimeManifest` for the test and guard CLI execution with:

```js
if (pathToFileURL(process.argv[1]).href === import.meta.url) {
  await main();
}
```

Use this electron-builder structure:

```yaml
appId: ai.voiceclaw.companion.linux
productName: VoiceClaw Companion
executableName: voiceclaw-companion
directories:
  output: dist
  buildResources: build-resources
files:
  - out/**
  - package.json
extraResources:
  - from: build-resources/BridgeRuntime
    to: BridgeRuntime
  - from: service/bridge-entry.mjs
    to: service/bridge-entry.mjs
  - from: ../Assets/AppIcon-1024.png
    to: AppIcon-1024.png
linux:
  target:
    - target: deb
      arch:
        - x64
  category: Utility
  icon: ../Assets/AppIcon-1024.png
  artifactName: voiceclaw-companion_${version}_${arch}.${ext}
deb:
  packageCategory: utils
  priority: optional
  synopsis: Linux companion for VoiceClaw Realtime
```

- [ ] **Step 4: Add package verification and Linux documentation**

`scripts/verify_linux_companion.sh` accepts one `.deb` path and checks:

```sh
dpkg-deb --info "$PACKAGE"
dpkg-deb --contents "$PACKAGE"
```

Require these packaged paths:

```text
/opt/VoiceClaw Companion/voiceclaw-companion
/opt/VoiceClaw Companion/resources/BridgeRuntime/package.json
/opt/VoiceClaw Companion/resources/BridgeRuntime/runtime-manifest.json
/opt/VoiceClaw Companion/resources/BridgeRuntime/server/index.js
/opt/VoiceClaw Companion/resources/service/bridge-entry.mjs
/usr/share/applications/voiceclaw-companion.desktop
```

Parse the manifest and require a 64-character lowercase SHA-256 runtime hash.

`docs/LINUX.md` documents Ubuntu 24.04 x86-64, `.deb` installation, service
ownership, six sections, manual phone pairing, read-only Tailscale behavior,
logs, reset scope, development commands, and uninstall behavior. Add a short
Linux link to the main README without changing the macOS instructions.

- [ ] **Step 5: Run all automated gates**

Run:

```sh
node scripts/check_runtime_contract.mjs
(
  cd BridgeRuntime
  npm ci
  npm run check
)
(
  cd LinuxCompanion
  npm ci
  npm test
  npm run lint
  npm run build
  npm run smoke:electron
  npm run package:deb
)
./scripts/verify_linux_companion.sh \
  LinuxCompanion/dist/voiceclaw-companion_0.1.0_amd64.deb
git diff --exit-code upstream/main -- \
  Package.swift Sources/VoiceClawBridge scripts/build_and_run.sh \
  scripts/package_release.sh scripts/verify_companion_app.sh
```

Expected: every command exits zero; BridgeRuntime reports zero failures;
LinuxCompanion tests pass; one verified Debian package exists; the existing
macOS build sources and scripts have no changes.

- [ ] **Step 6: Install and launch the Debian package**

Record Tailscale state before installation:

```sh
tailscale status --json \
  | jq -S '{BackendState, Self: {DNSName: .Self.DNSName}}' \
  > /tmp/voiceclaw-tailscale-before.json
tailscale serve status --json \
  | jq -S . \
  > /tmp/voiceclaw-serve-before.json
```

Install:

```sh
sudo dpkg -i LinuxCompanion/dist/voiceclaw-companion_0.1.0_amd64.deb
```

Launch from the desktop environment and verify:

- the window reaches 920-by-660 or larger;
- all six navigation destinations render;
- the tray menu opens;
- Diagnostics completes without crashing;
- Tailscale controls are read-only;
- no iPhone pairing action starts.

- [ ] **Step 7: Run an isolated bridge smoke service**

Implement `smoke-installed.mjs` to create a `mkdtemp` directory, reserve a fresh
loopback port, write a mode-`0600` temporary bridge config, and start a uniquely
named transient user service with `systemd-run --user`. The service uses the
installed Electron executable with `ELECTRON_RUN_AS_NODE=1`, the packaged
`resources/service/bridge-entry.mjs`, and explicit temporary
`VOICECLAW_CONFIG_PATH`/`VOICECLAW_APP_SUPPORT_DIR`. Its `finally` block stops
and resets only that transient unit and removes only the temporary directory.

Verify:

```sh
node LinuxCompanion/scripts/smoke-installed.mjs \
  --executable "/opt/VoiceClaw Companion/voiceclaw-companion" \
  --service-entry "/opt/VoiceClaw Companion/resources/service/bridge-entry.mjs"
```

Require `ok=true`, the selected port, product `VoiceClaw Companion`, and the
packaged runtime hash. Stop and remove only the uniquely named transient smoke
unit and temporary directory.

- [ ] **Step 8: Prove Tailscale state is unchanged**

```sh
tailscale status --json \
  | jq -S '{BackendState, Self: {DNSName: .Self.DNSName}}' \
  > /tmp/voiceclaw-tailscale-after.json
tailscale serve status --json \
  | jq -S . \
  > /tmp/voiceclaw-serve-after.json
cmp /tmp/voiceclaw-tailscale-before.json /tmp/voiceclaw-tailscale-after.json
cmp /tmp/voiceclaw-serve-before.json /tmp/voiceclaw-serve-after.json
```

Expected: both comparisons exit zero.

- [ ] **Step 9: Update Graphify when applicable**

Run only if `graphify-out/graph.json` exists:

```sh
graphify update .
```

Expected: the graph update exits zero. If no graph exists, record that this
repository has no graph to update.

- [ ] **Step 10: Commit and publish the branch**

```sh
git add .gitignore README.md docs/LINUX.md \
  LinuxCompanion/electron-builder.yml LinuxCompanion/scripts \
  scripts/verify_linux_companion.sh
git commit -m "build: package Linux VoiceClaw Companion"
git status --short
git push -u origin linux-electron-port
```

Expected: the worktree is clean and
`origin/linux-electron-port` points at the verified commit.
