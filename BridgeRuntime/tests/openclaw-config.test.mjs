import assert from 'node:assert/strict';
import test from 'node:test';

import {
  configuredOpenClawAgentDirectories,
  configuredOpenClawAgents,
  parseOpenClawConfig,
  resolveConfiguredOpenClawAgent,
} from '../server/openclaw-config.js';

const HOME = '/Users/tester';

test('keyed agents.entries identifies the map key and inherits the default workspace', () => {
  const config = {
    agents: {
      defaults: { workspace: '~/.openclaw/workspace' },
      entries: {
        julian: { heartbeat: { every: '2h' } },
        forge: { workspace: '~/.openclaw/workspace-forge' },
      },
    },
  };

  const { catalog, agent } = resolveConfiguredOpenClawAgent(config, 'JULIAN', { home: HOME });
  assert.deepEqual(catalog.ids, ['julian', 'forge']);
  assert.equal(catalog.defaultAgentID, 'julian');
  assert.equal(agent?.id, 'julian');
  assert.equal(agent?.workspace, '/Users/tester/.openclaw/workspace');
  assert.deepEqual(agent?.sources, ['agents.entries']);
});

test('agents.list supports explicit defaults, names as aliases, and custom agent directories', () => {
  const config = {
    agents: {
      defaults: { workspace: '~/.openclaw/workspace' },
      list: [
        { id: 'worker', name: 'Research Worker' },
        { id: 'main', default: true, agentDir: '~/custom/main-agent' },
      ],
    },
  };

  const catalog = configuredOpenClawAgents(config, { home: HOME });
  assert.equal(catalog.defaultAgentID, 'main');
  assert.equal(resolveConfiguredOpenClawAgent(config, 'research worker', { home: HOME }).agent?.id, 'worker');
  assert.deepEqual(configuredOpenClawAgentDirectories(config, { home: HOME }), [
    '/Users/tester/custom/main-agent',
  ]);
});

test('hybrid list and keyed entries merge overrides without losing list identity', () => {
  const config = {
    agents: {
      defaults: { workspace: '~/.openclaw/workspace' },
      list: [{ id: 'julian', default: true, name: 'Primary' }],
      entries: { julian: { agentDir: '~/.openclaw/agents/julian/custom-agent' } },
    },
  };

  const { agent } = resolveConfiguredOpenClawAgent(config, 'primary', { home: HOME });
  assert.equal(agent?.id, 'julian');
  assert.equal(agent?.agentDir, '/Users/tester/.openclaw/agents/julian/custom-agent');
  assert.deepEqual(agent?.sources, ['agents.list', 'agents.entries']);
});

test('an installation without explicit agents exposes only implicit main', () => {
  const config = { agents: { defaults: { workspace: '~/.openclaw/workspace' } } };
  const catalog = configuredOpenClawAgents(config, { home: HOME });
  assert.deepEqual(catalog.ids, ['main']);
  assert.equal(resolveConfiguredOpenClawAgent(config, 'main', { home: HOME }).agent?.workspace, '/Users/tester/.openclaw/workspace');
  assert.equal(resolveConfiguredOpenClawAgent(config, 'julian', { home: HOME }).agent, null);
});

test('legacy agent maps remain supported without mistaking modern container keys for ids', () => {
  const legacy = configuredOpenClawAgents({ agents: { julian: {}, forge: {} } }, { home: HOME });
  assert.deepEqual(legacy.ids, ['julian', 'forge']);

  const singularLegacy = configuredOpenClawAgents({ agent: { julian: {} } }, { home: HOME });
  assert.deepEqual(singularLegacy.ids, ['julian']);

  const modern = configuredOpenClawAgents({
    agents: { defaults: {}, entries: { julian: {} } },
  }, { home: HOME });
  assert.deepEqual(modern.ids, ['julian']);
  assert.equal(modern.ids.includes('defaults'), false);
  assert.equal(modern.ids.includes('entries'), false);
});

test('JSON5 OpenClaw config syntax is accepted', () => {
  const parsed = parseOpenClawConfig(`{
    agents: {
      defaults: { workspace: "~/.openclaw/workspace", },
      entries: { julian: {}, },
    },
  }`);
  assert.equal(resolveConfiguredOpenClawAgent(parsed, 'julian', { home: HOME }).agent?.id, 'julian');
});
