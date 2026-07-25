import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { link, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import test from 'node:test';

import { ArtifactInbox, ArtifactInboxError } from '../server/artifact-inbox.js';

async function fixture(t, options = {}) {
  const rootPath = await mkdtemp(join(tmpdir(), 'voiceclaw-artifacts-'));
  t.after(() => rm(rootPath, { recursive: true, force: true }));
  const inbox = new ArtifactInbox({ rootPath, stableDelayMs: 0, ...options });
  return { rootPath, inbox };
}

test('prepares a task-specific drop directory and admits a stable regular file', async (t) => {
  const { inbox } = await fixture(t);
  const prepared = await inbox.prepareTask('task-1');
  assert.match(prepared.instruction, /50 MB/);
  const data = Buffer.from('VoiceClaw artifact');
  const source = join(prepared.dropPath, 'report.txt');
  await writeFile(source, data);
  const artifact = await inbox.admit('task-1', source);
  assert.equal(artifact.byteCount, data.length);
  assert.equal(artifact.sha256, createHash('sha256').update(data).digest('hex'));
  assert.equal(artifact.contentType, 'text/plain');
  assert.equal((await inbox.status()).totalBytes, data.length);
  assert.deepEqual((await inbox.list({ taskID: 'task-1' })).artifacts.map((item) => item.artifactID), [artifact.artifactID]);
});

test('accepts a file exactly at the per-file limit and rejects one byte over it', async (t) => {
  const { inbox } = await fixture(t, { fileLimitBytes: 32, inboxLimitBytes: 128 });
  const first = await inbox.prepareTask('exact');
  await writeFile(join(first.dropPath, 'exact.bin'), Buffer.alloc(32, 1));
  assert.equal((await inbox.admit('exact', join(first.dropPath, 'exact.bin'))).byteCount, 32);
  const second = await inbox.prepareTask('over');
  await writeFile(join(second.dropPath, 'over.bin'), Buffer.alloc(33, 2));
  await assert.rejects(
    inbox.admit('over', join(second.dropPath, 'over.bin')),
    (error) => error instanceof ArtifactInboxError && error.code === 'file_too_large',
  );
});

test('total capacity rejects new data without evicting admitted artifacts', async (t) => {
  const { inbox } = await fixture(t, { fileLimitBytes: 64, inboxLimitBytes: 64 });
  const first = await inbox.prepareTask('first');
  await writeFile(join(first.dropPath, 'one.bin'), Buffer.alloc(40, 1));
  const admitted = await inbox.admit('first', join(first.dropPath, 'one.bin'));
  const second = await inbox.prepareTask('second');
  await writeFile(join(second.dropPath, 'two.bin'), Buffer.alloc(25, 2));
  await assert.rejects(
    inbox.admit('second', join(second.dropPath, 'two.bin')),
    (error) => error instanceof ArtifactInboxError && error.code === 'inbox_full',
  );
  assert.equal((await inbox.metadata(admitted.artifactID)).byteCount, 40);
  assert.equal((await inbox.status()).artifactCount, 1);
});

test('rejects symlinks, hard links, directories, and paths outside the task drop', async (t) => {
  const { rootPath, inbox } = await fixture(t);
  const prepared = await inbox.prepareTask('unsafe');
  const outside = join(rootPath, 'outside.txt');
  await writeFile(outside, 'outside');
  await symlink(outside, join(prepared.dropPath, 'symbolic.txt'));
  await assert.rejects(inbox.admit('unsafe', join(prepared.dropPath, 'symbolic.txt')), /regular files/);

  const source = join(prepared.dropPath, 'source.txt');
  const hard = join(prepared.dropPath, 'hard.txt');
  await writeFile(source, 'linked');
  await link(source, hard);
  await assert.rejects(inbox.admit('unsafe', hard), /one link/);

  await mkdir(join(prepared.dropPath, 'folder'));
  await assert.rejects(inbox.admit('unsafe', join(prepared.dropPath, 'folder')), /regular files/);
  await assert.rejects(
    inbox.admit('unsafe', outside),
    (error) => error instanceof ArtifactInboxError && error.code === 'path_escape',
  );
});

test('range descriptors are exact and unsatisfiable ranges fail deterministically', async (t) => {
  const { inbox } = await fixture(t);
  const prepared = await inbox.prepareTask('ranges');
  await writeFile(join(prepared.dropPath, 'range.txt'), '0123456789');
  const artifact = await inbox.admit('ranges', join(prepared.dropPath, 'range.txt'));
  assert.deepEqual((await inbox.downloadDescriptor(artifact.artifactID, 'bytes=2-6')).range, { start: 2, end: 6 });
  assert.deepEqual((await inbox.downloadDescriptor(artifact.artifactID, 'bytes=-3')).range, { start: 7, end: 9 });
  await assert.rejects(
    inbox.downloadDescriptor(artifact.artifactID, 'bytes=50-60'),
    (error) => error instanceof ArtifactInboxError && error.status === 416,
  );
});

test('delete frees capacity and empty inbox requires a fresh confirmation token', async (t) => {
  const { inbox } = await fixture(t);
  for (const [taskID, name] of [['one', 'one.txt'], ['two', 'two.txt']]) {
    const prepared = await inbox.prepareTask(taskID);
    await writeFile(join(prepared.dropPath, name), taskID);
    await inbox.admit(taskID, join(prepared.dropPath, name));
  }
  const listed = await inbox.list();
  await inbox.delete(listed.artifacts[0].artifactID);
  assert.equal((await inbox.status()).artifactCount, 1);
  await assert.rejects(
    inbox.empty('wrong'),
    (error) => error instanceof ArtifactInboxError && error.code === 'confirmation_required',
  );
  const confirmation = await inbox.createEmptyConfirmation();
  assert.equal((await inbox.empty(confirmation.confirmationToken)).deleted, 1);
  assert.equal((await inbox.status()).artifactCount, 0);
});

test('manifest survives a new ArtifactInbox instance', async (t) => {
  const { rootPath, inbox } = await fixture(t);
  const prepared = await inbox.prepareTask('persistent');
  await writeFile(join(prepared.dropPath, 'saved.json'), '{"ok":true}');
  const artifact = await inbox.admit('persistent', join(prepared.dropPath, 'saved.json'));
  const reopened = new ArtifactInbox({ rootPath, stableDelayMs: 0 });
  assert.equal((await reopened.metadata(artifact.artifactID)).sha256, artifact.sha256);
  const descriptor = await reopened.downloadDescriptor(artifact.artifactID);
  assert.equal((await readFile(descriptor.path, 'utf8')), '{"ok":true}');
});
