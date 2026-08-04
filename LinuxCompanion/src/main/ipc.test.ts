// @vitest-environment node

import { describe, expect, it } from 'vitest';

import type { CompanionController } from './companion-controller';
import { registerCompanionIPC } from './ipc';

describe('Companion IPC', () => {
  it('registers only the fixed VoiceClaw IPC channels', () => {
    const channels = new Set<string>();
    const ipc = {
      handle(channel: string) {
        channels.add(channel);
      },
    };

    registerCompanionIPC(ipc, {} as CompanionController);
    expect([...channels].sort()).toEqual([
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
      'voiceclaw:realtime-auth:update',
      'voiceclaw:snapshot:get',
    ]);
  });
});
