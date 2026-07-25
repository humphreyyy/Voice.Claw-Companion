import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { mkdir, mkdtemp, rm, symlink, unlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Readable } from 'node:stream';
import test from 'node:test';

import {
  INPUT_ATTACHMENT_FILE_LIMIT_BYTES,
  InputAttachmentError,
  InputAttachmentStore,
  createInputAttachmentHTTPHandler,
} from '../server/input-attachments.js';

function sha256(buffer) {
  return createHash('sha256').update(buffer).digest('hex');
}

async function fixture(t, options = {}) {
  const rootPath = await mkdtemp(join(tmpdir(), 'voiceclaw-input-attachments-'));
  t.after(() => rm(rootPath, { recursive: true, force: true }));
  return { rootPath, store: new InputAttachmentStore({ rootPath, ...options }) };
}

async function upload(store, {
  taskID = 'task-1',
  attachmentID = 'attachment-1',
  name = 'report.txt',
  contentType = 'text/plain',
  body = Buffer.from('attachment'),
  contentLength = body.length,
  byteCount = contentLength,
  hash = sha256(body),
} = {}) {
  return store.upload({
    taskID,
    attachmentID,
    name,
    contentType,
    contentLength,
    byteCount,
    sha256: hash,
    stream: Readable.from([body]),
  });
}

test('the hard file limit is 50 MB and accepts the configured boundary exactly', async (t) => {
  assert.equal(INPUT_ATTACHMENT_FILE_LIMIT_BYTES, 52_428_800);
  const { store } = await fixture(t, { fileLimitBytes: 32, storeLimitBytes: 128 });
  const body = Buffer.alloc(32, 7);
  const metadata = await upload(store, { body });
  assert.equal(metadata.byteCount, 32);
  assert.equal(metadata.sha256, sha256(body));
  assert.equal(metadata.originalName, 'report.txt');
  assert.equal((await store.status()).totalBytes, 32);

  await assert.rejects(
    upload(store, { taskID: 'task-2', attachmentID: 'over', body: Buffer.alloc(33) }),
    (error) => error instanceof InputAttachmentError && error.code === 'attachment_too_large',
  );
});

test('byte count, body length, and caller SHA-256 must all match exactly', async (t) => {
  const { store } = await fixture(t, { fileLimitBytes: 64, storeLimitBytes: 256 });
  await assert.rejects(
    upload(store, { taskID: 'byte-count', byteCount: 9 }),
    (error) => error instanceof InputAttachmentError && error.code === 'byte_count_mismatch',
  );
  await assert.rejects(
    upload(store, { taskID: 'short', contentLength: 11, byteCount: 11 }),
    (error) => error instanceof InputAttachmentError && error.code === 'content_length_mismatch',
  );
  await assert.rejects(
    upload(store, { taskID: 'long', contentLength: 5, byteCount: 5 }),
    (error) => error instanceof InputAttachmentError && error.code === 'content_length_mismatch',
  );
  await assert.rejects(
    upload(store, { taskID: 'hash', hash: '0'.repeat(64) }),
    (error) => error instanceof InputAttachmentError && error.code === 'sha256_mismatch',
  );
  assert.equal((await store.status()).attachmentCount, 0);
});

test('rejects traversal identifiers, unsafe names, symlinked task paths, and tampered files', async (t) => {
  const { rootPath, store } = await fixture(t);
  await assert.rejects(
    upload(store, { taskID: '../escape' }),
    (error) => error instanceof InputAttachmentError && error.code === 'invalid_identifier',
  );
  await assert.rejects(
    upload(store, { name: '../outside.txt' }),
    (error) => error instanceof InputAttachmentError && error.code === 'invalid_name',
  );

  await store.prune();
  const outside = await mkdtemp(join(tmpdir(), 'voiceclaw-input-outside-'));
  t.after(() => rm(outside, { recursive: true, force: true }));
  await symlink(outside, join(rootPath, 'tasks', 'symlink-task'));
  await assert.rejects(
    upload(store, { taskID: 'symlink-task' }),
    (error) => error instanceof InputAttachmentError && ['unsafe_path', 'path_escape'].includes(error.code),
  );

  const metadata = await upload(store, { taskID: 'tampered-task', attachmentID: 'tampered' });
  await unlink(metadata.path);
  const outsideFile = join(outside, 'outside.txt');
  await writeFile(outsideFile, 'outside');
  await symlink(outsideFile, metadata.path);
  await assert.rejects(
    store.resolve('tampered-task', ['tampered']),
    (error) => error instanceof InputAttachmentError && error.code === 'unsafe_file',
  );

  const metadataTarget = join(outside, 'metadata.json');
  await writeFile(metadataTarget, '{}');
  await unlink(join(rootPath, 'tasks', 'tampered-task', 'tampered', 'metadata.json'));
  await symlink(metadataTarget, join(rootPath, 'tasks', 'tampered-task', 'tampered', 'metadata.json'));
  await assert.rejects(
    store.resolve('tampered-task', ['tampered']),
    (error) => error instanceof InputAttachmentError && error.code === 'unsafe_metadata',
  );
});

test('raw PUT handler accepts the iOS header contract and returns verified metadata', async (t) => {
  const { store } = await fixture(t);
  const handler = createInputAttachmentHTTPHandler({ store });
  const server = createServer(async (req, res) => {
    const handled = await handler.handle(req, res, new URL(req.url, 'http://localhost').pathname);
    if (!handled) {
      res.writeHead(404);
      res.end();
    }
  });
  t.after(() => server.close());
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const origin = `http://127.0.0.1:${server.address().port}`;
  const body = Buffer.from('verified input');
  const response = await fetch(`${origin}/realtime/tasks/preallocated/attachments/file-1`, {
    method: 'PUT',
    headers: {
      'Content-Type': 'text/plain',
      'Content-Length': String(body.length),
      'X-VoiceClaw-Filename-Base64': Buffer.from('notes.txt').toString('base64'),
      'X-VoiceClaw-Content-SHA256': sha256(body),
      'X-VoiceClaw-Byte-Count': String(body.length),
    },
    body,
  });
  assert.equal(response.status, 201);
  const payload = await response.json();
  assert.equal(payload.ok, true);
  assert.equal(payload.attachment.originalName, 'notes.txt');
  assert.equal(payload.attachment.byteCount, body.length);
  assert.equal(payload.attachment.sha256, sha256(body));
  assert.match(payload.attachment.path, /Input|voiceclaw-input-attachments/);
});

test('abandoned pre-create uploads are capacity bounded and expire after retention', async (t) => {
  let now = 1_800_000_000_000;
  const { store } = await fixture(t, {
    storeLimitBytes: 10,
    orphanRetentionMs: 60_000,
    now: () => now,
  });
  await upload(store, { taskID: 'abandoned', body: Buffer.alloc(8), contentLength: 8, byteCount: 8 });
  await assert.rejects(
    upload(store, { taskID: 'capacity', body: Buffer.alloc(3), contentLength: 3, byteCount: 3 }),
    (error) => error instanceof InputAttachmentError && error.code === 'attachment_store_full',
  );
  now += 60_001;
  assert.equal((await store.prune()).removedTasks, 1);
  assert.equal((await store.status()).totalBytes, 0);
});

test('crash-left partial upload bytes remain inside the hard store capacity', async (t) => {
  const { rootPath, store } = await fixture(t, { storeLimitBytes: 10 });
  await store.prune();
  const incompletePath = join(rootPath, 'tasks', 'interrupted-task', 'interrupted-file');
  await mkdir(incompletePath, { recursive: true, mode: 0o700 });
  await writeFile(join(incompletePath, '.upload-interrupted.partial'), Buffer.alloc(9), { mode: 0o600 });
  assert.equal((await store.status()).totalBytes, 9);
  await assert.rejects(
    upload(store, {
      taskID: 'next-task',
      attachmentID: 'next-file',
      body: Buffer.alloc(2),
      contentLength: 2,
      byteCount: 2,
    }),
    (error) => error instanceof InputAttachmentError && error.code === 'attachment_store_full',
  );
});
