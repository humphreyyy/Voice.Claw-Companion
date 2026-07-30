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
