import assert from 'node:assert/strict';
import test from 'node:test';

import {
  __openClawGatewayTestHooks,
  OpenClawRuntimeError,
} from '../server/openclaw-gateway.js';

test.afterEach(() => {
  __openClawGatewayTestHooks.resetConnectionsForTest();
  __openClawGatewayTestHooks.resetSpawnForTest();
});

test('Gateway authentication accepts literal and environment-backed credentials without exposing them', () => {
  const literal = __openClawGatewayTestHooks.gatewayAuthentication({
    gateway: { auth: { mode: 'token', token: 'literal-test-token' } },
  }, {});
  const referenced = __openClawGatewayTestHooks.gatewayAuthentication({
    gateway: { auth: { mode: 'token', token: { source: 'env', id: 'OPENCLAW_TEST_TOKEN' } } },
  }, { OPENCLAW_TEST_TOKEN: 'environment-test-token' });
  const unresolved = __openClawGatewayTestHooks.gatewayAuthentication({
    gateway: { auth: { mode: 'token', token: { source: 'file', path: '/private/token' } } },
  }, {});

  assert.equal(literal.token, 'literal-test-token');
  assert.equal(literal.directAvailable, true);
  assert.equal(referenced.token, 'environment-test-token');
  assert.equal(referenced.directAvailable, true);
  assert.equal(unresolved.token, undefined);
  assert.equal(unresolved.directAvailable, false);
});

test('Canonical agent merge supports list schema, entries schema, runtime defaults, and inherited workspaces', () => {
  const configured = {
    defaultAgentID: 'julian',
    agents: [
      { id: 'julian', workspace: '/workspace', isDefault: true, sources: ['agents.entries'] },
      { id: 'forge', workspace: '/workspace-forge', isDefault: false, sources: ['agents.list'] },
    ],
  };
  const merged = __openClawGatewayTestHooks.mergeAgentCatalog({
    configured,
    runtime: {
      defaultId: 'julian',
      agents: [
        { id: 'julian', workspace: '/workspace' },
        { id: 'runtime-only', workspace: '/runtime-only' },
      ],
    },
    selectedAgentID: 'forge',
  });

  assert.equal(merged.defaultAgentID, 'julian');
  assert.deepEqual(merged.agents.map((agent) => agent.id), ['julian', 'forge', 'runtime-only']);
  assert.equal(merged.agents[0].configured, true);
  assert.equal(merged.agents[0].runtimeVisible, true);
  assert.equal(merged.agents[2].configured, false);
  assert.equal(merged.agents[2].runtimeVisible, true);
});

test('Runtime errors preserve actionable protocol, schema, agent, and availability classes', () => {
  const cases = [
    ['unknown method: sessions.list', 'session_rpc_unavailable'],
    ['unsupported protocol version 5', 'gateway_protocol_mismatch'],
    ['database schema 6 is newer than supported schema 5', 'unsupported_newer_state_schema'],
    ['unknown agent: julian', 'agent_not_found'],
    ['connect ECONNREFUSED 127.0.0.1', 'gateway_unavailable'],
  ];
  for (const [message, expectedCode] of cases) {
    const classified = __openClawGatewayTestHooks.classifyRuntimeError(new Error(message), {
      method: 'sessions.list',
      transport: 'gateway-client',
    });
    assert.ok(classified instanceof OpenClawRuntimeError);
    assert.equal(classified.code, expectedCode, message);
  }
});
