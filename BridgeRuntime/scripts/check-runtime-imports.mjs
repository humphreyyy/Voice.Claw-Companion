import { builtinModules } from 'node:module';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, extname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const runtimeRoot = resolve(fileURLToPath(new URL('..', import.meta.url)));
const packageJson = JSON.parse(readFileSync(join(runtimeRoot, 'package.json'), 'utf8'));
const dependencyNames = new Set([
  ...Object.keys(packageJson.dependencies || {}),
  ...Object.keys(packageJson.optionalDependencies || {}),
  ...Object.keys(packageJson.peerDependencies || {}),
]);
const builtins = new Set([
  ...builtinModules,
  ...builtinModules.map((name) => `node:${name}`),
]);
const roots = ['server', 'scripts'];
const sourceFiles = [];
const failures = [];

function walk(dir) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === 'node_modules' || entry.name === 'ops-node') continue;
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      walk(full);
    } else if (/\.(mjs|js)$/.test(entry.name)) {
      sourceFiles.push(full);
    }
  }
}

function packageName(specifier) {
  if (specifier.startsWith('@')) return specifier.split('/').slice(0, 2).join('/');
  return specifier.split('/')[0];
}

function resolveRelativeImport(fromFile, specifier) {
  const base = resolve(dirname(fromFile), specifier);
  const candidates = extname(base)
    ? [base]
    : [base, `${base}.js`, `${base}.mjs`, join(base, 'index.js'), join(base, 'index.mjs')];
  return candidates.find((candidate) => existsSync(candidate) && statSync(candidate).isFile()) || '';
}

function checkImport(fromFile, specifier) {
  if (!specifier || specifier.startsWith('data:') || specifier.startsWith('http:') || specifier.startsWith('https:')) return;
  if (specifier.startsWith('.') || specifier.startsWith('/')) {
    const resolved = resolveRelativeImport(fromFile, specifier);
    if (!resolved) failures.push(`${fromFile}: missing relative import ${specifier}`);
    return;
  }
  if (builtins.has(specifier) || builtins.has(packageName(specifier))) return;
  const dependency = packageName(specifier);
  if (!dependencyNames.has(dependency)) {
    failures.push(`${fromFile}: bare import ${specifier} is not listed in BridgeRuntime/package.json dependencies`);
  }
}

for (const root of roots) {
  const path = join(runtimeRoot, root);
  if (existsSync(path)) walk(path);
}

for (const file of sourceFiles) {
  const source = readFileSync(file, 'utf8');
  for (const regex of [
    /\bimport\s+(?:[^'"]*?\s+from\s+)?['"]([^'"]+)['"]/gs,
    /\bimport\(\s*['"]([^'"]+)['"]\s*\)/gs,
  ]) {
    for (const match of source.matchAll(regex)) {
      checkImport(file, match[1]);
    }
  }
}

if (failures.length) {
  console.error('VoiceClaw BridgeRuntime import check failed:');
  for (const failure of failures) console.error(`- ${failure}`);
  process.exit(1);
}

console.log(`VoiceClaw BridgeRuntime import check passed (${sourceFiles.length} files).`);
