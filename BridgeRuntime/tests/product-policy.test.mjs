import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

import { PRODUCT_SURFACE_POLICY, accessItemIsVisible, setupProductPolicy } from '../server/product-policy.js';

test('dormant Companion Voice and Powerhouse surfaces remain implemented but hidden', () => {
  assert.equal(PRODUCT_SURFACE_POLICY.companionRealtimeVoiceVisible, false);
  assert.equal(PRODUCT_SURFACE_POLICY.powerhouseVisible, false);
  assert.equal(PRODUCT_SURFACE_POLICY.companionRealtimeVoiceBlocksReadiness, false);
  assert.equal(PRODUCT_SURFACE_POLICY.powerhouseBlocksReadiness, false);
  assert.equal(accessItemIsVisible({ id: 'hf-runtime' }), false);
  assert.equal(accessItemIsVisible({ id: 'hf-cache' }), false);
  assert.equal(accessItemIsVisible({ id: 'realtime-priority' }), false);
  assert.equal(accessItemIsVisible({ id: 'local-bridge' }), true);
  assert.deepEqual(setupProductPolicy(), {
    companionRealtimeVoiceVisible: false,
    powerhouseVisible: false,
    companionRealtimeVoiceBlocksReadiness: false,
    powerhouseBlocksReadiness: false,
  });
});

test('normal setup help does not advertise dormant product surfaces', () => {
  const script = fileURLToPath(new URL('../scripts/voiceclaw-bridge-setup.mjs', import.meta.url));
  const result = spawnSync(process.execPath, [script, '--help'], { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /VoiceClaw Realtime Companion setup/);
  assert.doesNotMatch(result.stdout, /install-companion-voice-deps/);
  assert.doesNotMatch(result.stdout, /powerhouse-mode/);
});
