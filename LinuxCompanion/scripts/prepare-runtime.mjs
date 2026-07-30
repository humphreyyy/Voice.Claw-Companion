import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  cp,
  chmod,
  copyFile,
  mkdir,
  readFile,
  readdir,
  rm,
  writeFile,
} from 'node:fs/promises';
import { basename, dirname, join, relative } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const scriptDirectory = dirname(fileURLToPath(import.meta.url));
const companionRoot = dirname(scriptDirectory);
const repositoryRoot = dirname(companionRoot);
const sourceRuntimeRoot = join(repositoryRoot, 'BridgeRuntime');
const stagedRuntimeRoot = join(companionRoot, 'build-resources', 'BridgeRuntime');
const buildResourcesRoot = join(companionRoot, 'build-resources');

async function runtimeFiles(root, directory = root) {
  const results = [];
  const entries = await readdir(directory, { withFileTypes: true });
  for (const entry of entries) {
    const absolutePath = join(directory, entry.name);
    const relativePath = relative(root, absolutePath);
    if (entry.isDirectory()) {
      results.push(...await runtimeFiles(root, absolutePath));
    } else if (entry.isFile() && relativePath !== 'runtime-manifest.json') {
      results.push(relativePath);
    }
  }
  return results.sort();
}

export async function buildRuntimeManifest({
  runtimeRoot,
  version,
  build,
  sourceCommit,
  files,
}) {
  const selectedFiles = files ? [...files].sort() : await runtimeFiles(runtimeRoot);
  const digest = createHash('sha256');
  for (const file of selectedFiles) {
    digest.update(file);
    digest.update('\0');
    digest.update(await readFile(join(runtimeRoot, file)));
    digest.update('\0');
  }

  let runtimePackageVersion = '';
  try {
    const runtimePackage = JSON.parse(
      await readFile(join(runtimeRoot, 'package.json'), 'utf8'),
    );
    runtimePackageVersion = String(runtimePackage.version || '');
  } catch {
    runtimePackageVersion = '';
  }

  return {
    product: 'VoiceClaw Companion',
    version: String(version),
    build: String(build),
    runtimePackageVersion,
    runtimeHash: digest.digest('hex'),
    entryPoint: 'server/index.js',
    generatedAt: new Date().toISOString(),
    sourceCommit: String(sourceCommit),
  };
}

function run(executable, args, cwd) {
  return new Promise((resolve, reject) => {
    const child = spawn(executable, args, {
      cwd,
      stdio: 'inherit',
      shell: false,
    });
    child.once('error', reject);
    child.once('exit', (code) => {
      if (code === 0) {
        resolve();
      } else {
        reject(new Error(`${basename(executable)} exited with code ${code}.`));
      }
    });
  });
}

async function gitOutput(args) {
  return new Promise((resolve, reject) => {
    const child = spawn('git', args, {
      cwd: repositoryRoot,
      stdio: ['ignore', 'pipe', 'inherit'],
      shell: false,
    });
    let output = '';
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk) => {
      output += chunk;
    });
    child.once('error', reject);
    child.once('exit', (code) => code === 0
      ? resolve(output.trim())
      : reject(new Error(`git exited with code ${code}.`)));
  });
}

function includeRuntimePath(source) {
  const relativePath = relative(sourceRuntimeRoot, source);
  const parts = relativePath.split(/[\\/]/u);
  return !parts.includes('.git')
    && !parts.includes('tests')
    && !source.endsWith('.log');
}

function numericBuild(date = new Date()) {
  return date.toISOString().replace(/\D/gu, '').slice(0, 12);
}

async function normalizePermissions(directory) {
  await chmod(directory, 0o755);
  const entries = await readdir(directory, { withFileTypes: true });
  for (const entry of entries) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) {
      await normalizePermissions(path);
    } else if (entry.isFile()) {
      const executable = entry.name.endsWith('.sh')
        || entry.name === 'voiceclaw-bridge-setup.mjs';
      await chmod(path, executable ? 0o755 : 0o644);
    }
  }
}

async function main() {
  const companionPackage = JSON.parse(
    await readFile(join(companionRoot, 'package.json'), 'utf8'),
  );
  await run('npm', ['ci', '--omit=dev'], sourceRuntimeRoot);
  await rm(stagedRuntimeRoot, { recursive: true, force: true });
  await mkdir(dirname(stagedRuntimeRoot), { recursive: true });
  await cp(sourceRuntimeRoot, stagedRuntimeRoot, {
    recursive: true,
    filter: includeRuntimePath,
  });
  await rm(join(stagedRuntimeRoot, 'node_modules', '.bin'), {
    recursive: true,
    force: true,
  });
  await normalizePermissions(stagedRuntimeRoot);

  const stagedServiceDir = join(buildResourcesRoot, 'service');
  await mkdir(stagedServiceDir, { recursive: true, mode: 0o755 });
  await copyFile(
    join(companionRoot, 'service', 'bridge-entry.mjs'),
    join(stagedServiceDir, 'bridge-entry.mjs'),
  );
  await chmod(join(stagedServiceDir, 'bridge-entry.mjs'), 0o644);
  await copyFile(
    join(repositoryRoot, 'Assets', 'AppIcon-1024.png'),
    join(buildResourcesRoot, 'AppIcon-1024.png'),
  );
  await chmod(join(buildResourcesRoot, 'AppIcon-1024.png'), 0o644);

  const manifest = await buildRuntimeManifest({
    runtimeRoot: stagedRuntimeRoot,
    version: companionPackage.version,
    build: numericBuild(),
    sourceCommit: await gitOutput(['rev-parse', 'HEAD']),
  });
  await writeFile(
    join(stagedRuntimeRoot, 'runtime-manifest.json'),
    `${JSON.stringify(manifest, null, 2)}\n`,
    { mode: 0o644 },
  );
  console.log(
    `[voiceclaw-package] staged BridgeRuntime ${manifest.runtimePackageVersion} (${manifest.runtimeHash})`,
  );
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  await main();
}
