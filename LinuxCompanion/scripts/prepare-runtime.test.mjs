import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { buildRuntimeManifest } from './prepare-runtime.mjs';

test('builds a deterministic Linux runtime manifest', async () => {
  const root = await mkdtemp(join(tmpdir(), 'voiceclaw-linux-runtime-'));
  try {
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
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
