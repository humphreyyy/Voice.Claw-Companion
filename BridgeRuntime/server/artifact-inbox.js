import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import {
  constants,
  createReadStream,
} from 'node:fs';
import {
  copyFile,
  lstat,
  mkdir,
  open,
  readFile,
  readdir,
  realpath,
  rename,
  rm,
  stat,
  unlink,
  writeFile,
} from 'node:fs/promises';
import { basename, dirname, extname, join, resolve, sep } from 'node:path';
import { homedir } from 'node:os';

export const ARTIFACT_FILE_LIMIT_BYTES = 50 * 1024 * 1024;
export const ARTIFACT_INBOX_LIMIT_BYTES = 500 * 1024 * 1024;
export const ARTIFACT_FILES_PER_TASK_LIMIT = 10;
export const ARTIFACT_INBOX_SCHEMA_VERSION = 1;

const DEFAULT_ROOT = join(
  homedir(),
  'Library',
  'Application Support',
  'VoiceClaw Realtime Companion',
  'Artifact Inbox',
);
const MIME_BY_EXTENSION = Object.freeze({
  '.txt': 'text/plain',
  '.md': 'text/markdown',
  '.json': 'application/json',
  '.pdf': 'application/pdf',
  '.csv': 'text/csv',
  '.html': 'text/html',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.heic': 'image/heic',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.wav': 'audio/wav',
  '.mp3': 'audio/mpeg',
  '.m4a': 'audio/mp4',
  '.mp4': 'video/mp4',
  '.mov': 'video/quicktime',
  '.zip': 'application/zip',
});

function clone(value) {
  return value === undefined ? undefined : structuredClone(value);
}

function safeID(value, field) {
  const result = String(value || '').trim();
  if (!result || result.length > 256 || !/^[A-Za-z0-9._:-]+$/.test(result)) {
    throw new ArtifactInboxError('invalid_identifier', `${field} is invalid.`, 422);
  }
  return result;
}

function safeDisplayName(value) {
  const base = basename(String(value || 'artifact'))
    .replace(/[\u0000-\u001f\u007f]/g, '')
    .replace(/[/:\\]+/g, '-')
    .trim()
    .slice(0, 240);
  return base && base !== '.' && base !== '..' ? base : `artifact-${randomUUID()}`;
}

function within(parent, candidate) {
  const root = resolve(parent);
  const path = resolve(candidate);
  return path === root || path.startsWith(`${root}${sep}`);
}

function initialManifest() {
  return {
    schemaVersion: ARTIFACT_INBOX_SCHEMA_VERSION,
    totalBytes: 0,
    artifacts: {},
    tasks: {},
    confirmation: null,
  };
}

function publicArtifact(artifact) {
  return clone({
    schemaVersion: ARTIFACT_INBOX_SCHEMA_VERSION,
    artifactID: artifact.artifactID,
    taskID: artifact.taskID,
    displayName: artifact.displayName,
    originalName: artifact.originalName,
    byteCount: artifact.byteCount,
    sha256: artifact.sha256,
    contentType: artifact.contentType,
    admittedAt: artifact.admittedAt,
    sourceModifiedAt: artifact.sourceModifiedAt,
  });
}

function contentType(filename) {
  return MIME_BY_EXTENSION[extname(filename).toLowerCase()] || 'application/octet-stream';
}

async function sha256(path) {
  const digest = createHash('sha256');
  const handle = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW || 0));
  try {
    for await (const chunk of handle.createReadStream({ autoClose: false })) digest.update(chunk);
  } finally {
    await handle.close();
  }
  return digest.digest('hex');
}

function parseRange(value, size) {
  if (!value) return null;
  const match = /^bytes=(\d*)-(\d*)$/.exec(String(value).trim());
  if (!match || (!match[1] && !match[2])) throw new ArtifactInboxError('invalid_range', 'The byte range is invalid.', 416);
  let start;
  let end;
  if (!match[1]) {
    const suffix = Number(match[2]);
    if (!Number.isSafeInteger(suffix) || suffix <= 0) throw new ArtifactInboxError('invalid_range', 'The byte range is invalid.', 416);
    start = Math.max(0, size - suffix);
    end = size - 1;
  } else {
    start = Number(match[1]);
    end = match[2] ? Number(match[2]) : size - 1;
  }
  if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 0 || end < start || start >= size) {
    throw new ArtifactInboxError('range_not_satisfiable', 'The byte range is outside this artifact.', 416, { size });
  }
  return { start, end: Math.min(end, size - 1) };
}

export class ArtifactInboxError extends Error {
  constructor(code, message, status = 400, details = null) {
    super(message);
    this.name = 'ArtifactInboxError';
    this.code = code;
    this.status = status;
    this.details = details;
  }
}

export class ArtifactInbox {
  constructor({
    rootPath = process.env.VOICECLAW_ARTIFACT_INBOX_PATH || DEFAULT_ROOT,
    fileLimitBytes = ARTIFACT_FILE_LIMIT_BYTES,
    inboxLimitBytes = ARTIFACT_INBOX_LIMIT_BYTES,
    filesPerTaskLimit = ARTIFACT_FILES_PER_TASK_LIMIT,
    stableDelayMs = 350,
    now = () => Date.now(),
  } = {}) {
    this.rootPath = resolve(rootPath);
    this.manifestPath = join(this.rootPath, 'manifest.json');
    this.fileLimitBytes = Number(fileLimitBytes);
    this.inboxLimitBytes = Number(inboxLimitBytes);
    this.filesPerTaskLimit = Number(filesPerTaskLimit);
    this.stableDelayMs = Math.max(0, Number(stableDelayMs) || 0);
    this.now = now;
    this.manifest = null;
    this.tail = Promise.resolve();
  }

  async prepareTask(taskID) {
    const id = safeID(taskID, 'taskID');
    return this.#exclusive(async () => {
      const manifest = await this.#load();
      const taskRoot = join(this.rootPath, 'tasks', id);
      const dropPath = join(taskRoot, 'drop');
      const admittedPath = join(taskRoot, 'admitted');
      await mkdir(dropPath, { recursive: true, mode: 0o700 });
      await mkdir(admittedPath, { recursive: true, mode: 0o700 });
      manifest.tasks[id] ||= { taskID: id, createdAt: this.now(), artifactIDs: [] };
      await this.#persist(manifest);
      return {
        taskID: id,
        dropPath,
        admittedPath,
        instruction: [
          'The user explicitly requested that the resulting file be returned to VoiceClaw Realtime.',
          'After completing the task, place a copy of each requested regular file in this exact directory:',
          dropPath,
          `Each file must be ${this.fileLimitBytes} bytes (${Math.floor(this.fileLimitBytes / 1024 / 1024)} MB) or smaller.`,
          'Do not place directories, packages, symlinks, hard links, sockets, devices, or unrelated files there.',
          'Also describe the result normally in your response.',
        ].join('\n'),
      };
    });
  }

  async scanTask(taskID) {
    const prepared = await this.prepareTask(taskID);
    const candidates = await readdir(prepared.dropPath, { withFileTypes: true });
    if (candidates.length > this.filesPerTaskLimit) {
      throw new ArtifactInboxError('task_file_limit', `A task may return at most ${this.filesPerTaskLimit} files.`, 413);
    }
    const artifacts = [];
    for (const entry of candidates) {
      if (!entry.isFile()) {
        throw new ArtifactInboxError('unsupported_file_type', `Returned item ${entry.name} is not a regular file.`, 422);
      }
      artifacts.push(await this.admit(taskID, join(prepared.dropPath, entry.name)));
    }
    return { artifacts };
  }

  async admit(taskID, candidatePath) {
    const id = safeID(taskID, 'taskID');
    const candidate = resolve(candidatePath);
    const taskDrop = join(this.rootPath, 'tasks', id, 'drop');
    if (!within(taskDrop, candidate) || candidate === resolve(taskDrop)) {
      throw new ArtifactInboxError('path_escape', 'The returned file is outside its assigned task directory.', 422);
    }
    const before = await lstat(candidate);
    if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1) {
      throw new ArtifactInboxError('unsupported_file_type', 'Only ordinary regular files with one link are accepted.', 422);
    }
    if (before.size > this.fileLimitBytes) {
      throw new ArtifactInboxError('file_too_large', `Returned files must be ${this.fileLimitBytes} bytes or smaller.`, 413);
    }
    if (this.stableDelayMs) await new Promise((resolvePromise) => setTimeout(resolvePromise, this.stableDelayMs));
    const after = await lstat(candidate);
    if (!after.isFile() || after.isSymbolicLink() || after.nlink !== 1
        || before.size !== after.size || before.mtimeMs !== after.mtimeMs) {
      throw new ArtifactInboxError('file_not_stable', 'The returned file is still changing. Try again after the runtime finishes writing it.', 409);
    }
    const canonicalDrop = await realpath(taskDrop);
    const canonicalCandidate = await realpath(candidate);
    if (!within(canonicalDrop, canonicalCandidate)) {
      throw new ArtifactInboxError('path_escape', 'The returned file resolves outside its assigned task directory.', 422);
    }

    return this.#exclusive(async () => {
      const manifest = await this.#load();
      const task = manifest.tasks[id] || { taskID: id, createdAt: this.now(), artifactIDs: [] };
      if (task.artifactIDs.length >= this.filesPerTaskLimit) {
        throw new ArtifactInboxError('task_file_limit', `A task may return at most ${this.filesPerTaskLimit} files.`, 413);
      }
      if (manifest.totalBytes + after.size > this.inboxLimitBytes) {
        throw new ArtifactInboxError('inbox_full', 'The VoiceClaw Realtime Companion Inbox is full. Delete files manually and ask the runtime to export again.', 507, {
          currentBytes: manifest.totalBytes,
          requestedBytes: after.size,
          limitBytes: this.inboxLimitBytes,
        });
      }
      const artifactID = randomUUID();
      const displayName = safeDisplayName(basename(candidate));
      const admittedDirectory = join(this.rootPath, 'tasks', id, 'admitted');
      await mkdir(admittedDirectory, { recursive: true, mode: 0o700 });
      const destination = join(admittedDirectory, `${artifactID}-${displayName}`);
      await copyFile(candidate, destination, constants.COPYFILE_EXCL);
      const copied = await lstat(destination);
      if (!copied.isFile() || copied.nlink !== 1 || copied.size !== after.size) {
        await rm(destination, { force: true });
        throw new ArtifactInboxError('copy_validation_failed', 'The returned file could not be admitted safely.', 500);
      }
      const digest = await sha256(destination);
      const artifact = {
        artifactID,
        taskID: id,
        displayName,
        originalName: basename(candidate),
        path: destination,
        byteCount: copied.size,
        sha256: digest,
        contentType: contentType(displayName),
        admittedAt: this.now(),
        sourceModifiedAt: after.mtimeMs,
      };
      manifest.artifacts[artifactID] = artifact;
      manifest.tasks[id] = task;
      task.artifactIDs.push(artifactID);
      manifest.totalBytes += copied.size;
      await this.#persist(manifest);
      await unlink(candidate).catch(() => null);
      return publicArtifact(artifact);
    });
  }

  async status() {
    return this.#exclusive(async () => {
      const manifest = await this.#load();
      return {
        schemaVersion: ARTIFACT_INBOX_SCHEMA_VERSION,
        fileLimitBytes: this.fileLimitBytes,
        inboxLimitBytes: this.inboxLimitBytes,
        filesPerTaskLimit: this.filesPerTaskLimit,
        totalBytes: manifest.totalBytes,
        availableBytes: Math.max(0, this.inboxLimitBytes - manifest.totalBytes),
        artifactCount: Object.keys(manifest.artifacts).length,
        rootPath: this.rootPath,
      };
    });
  }

  async list({ taskID = '' } = {}) {
    return this.#exclusive(async () => {
      const manifest = await this.#load();
      const target = String(taskID || '').trim();
      const artifacts = Object.values(manifest.artifacts)
        .filter((artifact) => !target || artifact.taskID === target)
        .sort((a, b) => b.admittedAt - a.admittedAt)
        .map(publicArtifact);
      return { artifacts, status: await this.#statusFromManifest(manifest) };
    });
  }

  async metadata(artifactID) {
    return this.#exclusive(async () => publicArtifact(this.#requireArtifact(await this.#load(), artifactID)));
  }

  async downloadDescriptor(artifactID, rangeHeader = '') {
    return this.#exclusive(async () => {
      const artifact = this.#requireArtifact(await this.#load(), artifactID);
      const file = await stat(artifact.path);
      if (!file.isFile() || file.size !== artifact.byteCount) {
        throw new ArtifactInboxError('artifact_unavailable', 'The artifact is no longer available.', 410);
      }
      const range = parseRange(rangeHeader, artifact.byteCount);
      return { artifact: publicArtifact(artifact), path: artifact.path, range };
    });
  }

  async delete(artifactID) {
    const id = safeID(artifactID, 'artifactID');
    return this.#exclusive(async () => {
      const manifest = await this.#load();
      const artifact = this.#requireArtifact(manifest, id);
      await unlink(artifact.path).catch((error) => {
        if (error?.code !== 'ENOENT') throw error;
      });
      delete manifest.artifacts[id];
      manifest.totalBytes = Math.max(0, manifest.totalBytes - artifact.byteCount);
      const task = manifest.tasks[artifact.taskID];
      if (task) task.artifactIDs = task.artifactIDs.filter((candidate) => candidate !== id);
      await this.#persist(manifest);
      return { deleted: true, artifactID: id, totalBytes: manifest.totalBytes };
    });
  }

  async createEmptyConfirmation() {
    return this.#exclusive(async () => {
      const manifest = await this.#load();
      const token = randomBytes(32).toString('base64url');
      manifest.confirmation = {
        hash: createHash('sha256').update(token).digest('hex'),
        expiresAt: this.now() + 60_000,
      };
      await this.#persist(manifest);
      return { confirmationToken: token, expiresAt: manifest.confirmation.expiresAt };
    });
  }

  async empty(confirmationToken) {
    return this.#exclusive(async () => {
      const manifest = await this.#load();
      const expected = Buffer.from(manifest.confirmation?.hash || '', 'hex');
      const actual = Buffer.from(createHash('sha256').update(String(confirmationToken || '')).digest('hex'), 'hex');
      if (!manifest.confirmation || manifest.confirmation.expiresAt < this.now()
          || expected.length !== actual.length || !timingSafeEqual(expected, actual)) {
        throw new ArtifactInboxError('confirmation_required', 'Empty Inbox requires a fresh confirmation token.', 409);
      }
      const count = Object.keys(manifest.artifacts).length;
      await rm(join(this.rootPath, 'tasks'), { recursive: true, force: true });
      const next = initialManifest();
      await this.#persist(next);
      return { deleted: count, totalBytes: 0 };
    });
  }

  async #load() {
    if (this.manifest) return this.manifest;
    await mkdir(this.rootPath, { recursive: true, mode: 0o700 });
    try {
      const parsed = JSON.parse(await readFile(this.manifestPath, 'utf8'));
      this.manifest = parsed?.schemaVersion === ARTIFACT_INBOX_SCHEMA_VERSION ? parsed : initialManifest();
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error;
      this.manifest = initialManifest();
    }
    return this.manifest;
  }

  async #persist(manifest) {
    await mkdir(dirname(this.manifestPath), { recursive: true, mode: 0o700 });
    const temporary = `${this.manifestPath}.${process.pid}.${randomUUID()}.tmp`;
    await writeFile(temporary, `${JSON.stringify(manifest, null, 2)}\n`, { mode: 0o600 });
    await rename(temporary, this.manifestPath);
    this.manifest = manifest;
  }

  #requireArtifact(manifest, artifactID) {
    const id = safeID(artifactID, 'artifactID');
    const artifact = manifest.artifacts[id];
    if (!artifact) throw new ArtifactInboxError('unknown_artifact', 'The artifact was not found.', 404);
    return artifact;
  }

  #statusFromManifest(manifest) {
    return {
      fileLimitBytes: this.fileLimitBytes,
      inboxLimitBytes: this.inboxLimitBytes,
      totalBytes: manifest.totalBytes,
      availableBytes: Math.max(0, this.inboxLimitBytes - manifest.totalBytes),
      artifactCount: Object.keys(manifest.artifacts).length,
    };
  }

  #exclusive(operation) {
    const run = this.tail.then(operation, operation);
    this.tail = run.catch(() => {});
    return run;
  }
}

function sendJSON(res, status, body, headers = {}) {
  res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', ...headers });
  res.end(JSON.stringify(body));
}

export function createArtifactInboxHTTPHandler({ inbox, basePath = '' } = {}) {
  if (!inbox) throw new Error('Artifact inbox is required.');
  const normalizedBasePath = basePath ? `/${String(basePath).replace(/^\/+|\/+$/g, '')}` : '';
  const prefix = `${normalizedBasePath}/realtime/artifacts`;
  return {
    inbox,
    async handle(req, res, urlPath) {
      if (urlPath !== prefix && !urlPath.startsWith(`${prefix}/`)) return false;
      try {
        const suffix = urlPath.slice(prefix.length).replace(/^\//, '');
        const parts = suffix ? suffix.split('/').map(decodeURIComponent) : [];
        if (!parts.length && req.method === 'GET') {
          sendJSON(res, 200, { ok: true, ...(await inbox.list()) });
          return true;
        }
        if (parts[0] === 'status' && req.method === 'GET') {
          sendJSON(res, 200, { ok: true, ...(await inbox.status()) });
          return true;
        }
        if (parts[0] === 'empty-confirmation' && req.method === 'POST') {
          sendJSON(res, 200, { ok: true, ...(await inbox.createEmptyConfirmation()) });
          return true;
        }
        if (!parts.length && req.method === 'DELETE') {
          sendJSON(res, 200, { ok: true, ...(await inbox.empty(req.headers['x-voiceclaw-empty-confirmation'])) });
          return true;
        }
        const artifactID = parts[0];
        if (artifactID && req.method === 'GET') {
          const descriptor = await inbox.downloadDescriptor(artifactID, req.headers.range);
          const { artifact, path, range } = descriptor;
          const headers = {
            'Content-Type': artifact.contentType,
            'Content-Disposition': `attachment; filename*=UTF-8''${encodeURIComponent(artifact.displayName)}`,
            'Accept-Ranges': 'bytes',
            'X-VoiceClaw-Artifact-SHA256': artifact.sha256,
            'Cache-Control': 'private, no-store',
          };
          if (range) {
            const length = range.end - range.start + 1;
            res.writeHead(206, {
              ...headers,
              'Content-Length': length,
              'Content-Range': `bytes ${range.start}-${range.end}/${artifact.byteCount}`,
            });
            createReadStream(path, { start: range.start, end: range.end }).pipe(res);
          } else {
            res.writeHead(200, { ...headers, 'Content-Length': artifact.byteCount });
            createReadStream(path).pipe(res);
          }
          return true;
        }
        if (artifactID && req.method === 'DELETE') {
          sendJSON(res, 200, { ok: true, ...(await inbox.delete(artifactID)) });
          return true;
        }
        throw new ArtifactInboxError('unknown_route', 'Unknown artifact endpoint.', 404);
      } catch (error) {
        const failure = error instanceof ArtifactInboxError
          ? error
          : new ArtifactInboxError('artifact_internal_error', 'The Companion could not complete the artifact request.', 500);
        if (!(error instanceof ArtifactInboxError)) console.error('[artifact-inbox]', error?.stack || error);
        if (!res.headersSent) {
          const headers = failure.status === 416 && failure.details?.size
            ? { 'Content-Range': `bytes */${failure.details.size}` }
            : {};
          sendJSON(res, failure.status, { ok: false, error: { code: failure.code, message: failure.message, ...(failure.details ? { details: failure.details } : {}) } }, headers);
        } else res.end();
      }
      return true;
    },
  };
}
