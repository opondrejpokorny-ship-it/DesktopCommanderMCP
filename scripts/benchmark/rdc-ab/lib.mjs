import fs from 'node:fs/promises';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';

const VARIANTS = ['clean', 'prototype'];

export function validateManifest(manifest) {
  if (!manifest || manifest.schemaVersion !== 1) {
    throw new Error('Unsupported benchmark schemaVersion');
  }
  if (typeof manifest.benchmarkRoot !== 'string' || manifest.benchmarkRoot.length === 0) {
    throw new Error('benchmarkRoot is required');
  }
  if (!manifest.variants || typeof manifest.variants !== 'object') {
    throw new Error('variants are required');
  }
  const keys = Object.keys(manifest.variants).sort();
  if (keys.length !== VARIANTS.length || keys.some((key, index) => key !== VARIANTS[index])) {
    throw new Error('Manifest variants must be exactly clean and prototype');
  }
  for (const variant of VARIANTS) {
    const entry = manifest.variants[variant];
    if (!entry || typeof entry.repoPath !== 'string') throw new Error(`${variant} repoPath is required`);
    if (!/^[0-9a-f]{40}$/i.test(entry.expectedSha ?? '')) {
      throw new Error(`${variant} expectedSha must be a full Git SHA`);
    }
    if (entry.buildDigest !== undefined && !/^[0-9a-f]{64}$/i.test(entry.buildDigest)) {
      throw new Error(`${variant} buildDigest must be SHA-256 hex`);
    }
    if (!/^[0-9a-f]{64}$/.test(entry.runtimeDigest ?? '')) {
      throw new Error(`${variant} runtimeDigest is required and must be lowercase SHA-256 hex`);
    }
  }
  return manifest;
}

function isWithin(root, candidate) {
  const relative = path.relative(path.resolve(root), path.resolve(candidate));
  return relative !== '' && !relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative);
}

function gitHead(repoPath) {
  return execFileSync('git', ['-C', repoPath, 'rev-parse', 'HEAD'], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  }).trim();
}

function assertTrackedWorktreeClean(repoPath, variant) {
  try {
    execFileSync('git', ['-C', repoPath, 'diff', '--no-ext-diff', '--quiet', 'HEAD', '--'], {
      stdio: ['ignore', 'ignore', 'pipe'],
    });
  } catch (error) {
    if (error?.status === 1) {
      throw new Error(`${variant} tracked worktree differs from HEAD`);
    }
    throw new Error(`${variant} tracked worktree could not be compared with HEAD`);
  }
}

async function assertNoReparsePath(root, target, label) {
  let current = path.resolve(root);
  let stat;
  try {
    stat = await fs.lstat(current);
  } catch {
    throw new Error(`${label} must resolve to a real directory`);
  }
  if (stat.isSymbolicLink() || !stat.isDirectory()) {
    throw new Error(`${label} must not contain a symlink, junction, or reparse point`);
  }
  const relative = path.relative(current, path.resolve(target));
  for (const part of relative.split(path.sep)) {
    if (part === '') continue;
    current = path.join(current, part);
    try {
      stat = await fs.lstat(current);
    } catch {
      throw new Error(`${label} must resolve to a real directory`);
    }
    if (stat.isSymbolicLink() || !stat.isDirectory()) {
      throw new Error(`${label} must not contain a symlink, junction, or reparse point`);
    }
  }
}

export async function runtimeDigest(repoPath) {
  const files = [];
  async function visit(directory, relative = '') {
    const entries = await fs.readdir(directory, { withFileTypes: true });
    for (const entry of entries) {
      if (relative === '' && entry.name === '.git') continue;
      const childPath = path.join(directory, entry.name);
      const childRelative = relative === '' ? entry.name : `${relative}/${entry.name}`;
      const stat = await fs.lstat(childPath);
      if (stat.isSymbolicLink()) {
        throw new Error('Runtime digest rejects a symlink, junction, or reparse point');
      }
      if (stat.isDirectory()) {
        await visit(childPath, childRelative);
      } else if (stat.isFile()) {
        files.push({ path: childPath, relative: childRelative });
      } else {
        throw new Error('Runtime digest rejects a non-file, non-directory entry');
      }
    }
  }

  const rootStat = await fs.lstat(repoPath);
  if (rootStat.isSymbolicLink() || !rootStat.isDirectory()) {
    throw new Error('Runtime digest repository must be a real directory');
  }
  await visit(repoPath);
  files.sort((left, right) => (
    left.relative < right.relative ? -1 : left.relative > right.relative ? 1 : 0
  ));
  const digest = createHash('sha256');
  for (const file of files) {
    const fileDigest = createHash('sha256').update(await fs.readFile(file.path)).digest('hex');
    digest.update(`${file.relative}\0${fileDigest}\n`, 'utf8');
  }
  return digest.digest('hex');
}

export async function verifyVariant(manifestInput, variant) {
  const manifest = validateManifest(manifestInput);
  if (!VARIANTS.includes(variant)) throw new Error(`Unknown benchmark variant: ${variant}`);
  const entry = manifest.variants[variant];
  if (!isWithin(manifest.benchmarkRoot, entry.repoPath)) {
    throw new Error(`${variant} repoPath must stay within benchmark root`);
  }
  await assertNoReparsePath(manifest.benchmarkRoot, entry.repoPath, `${variant} repoPath`);
  let canonicalRoot;
  let canonicalRepo;
  try {
    [canonicalRoot, canonicalRepo] = await Promise.all([
      fs.realpath(manifest.benchmarkRoot),
      fs.realpath(entry.repoPath),
    ]);
  } catch {
    throw new Error(`${variant} repoPath and benchmark root must resolve to real filesystem paths`);
  }
  if (!isWithin(canonicalRoot, canonicalRepo)) {
    throw new Error(`${variant} repoPath real path must stay within benchmark root`);
  }
  const actualSha = gitHead(canonicalRepo);
  if (actualSha.toLowerCase() !== entry.expectedSha.toLowerCase()) {
    throw new Error(`${variant} SHA mismatch: expected ${entry.expectedSha}, got ${actualSha}`);
  }
  const entrypoint = path.join(canonicalRepo, 'dist', 'index.js');
  try {
    await fs.access(entrypoint);
  } catch {
    throw new Error(`${variant} build entrypoint is missing: ${entrypoint}`);
  }
  if (entry.buildDigest !== undefined) {
    const actualBuildDigest = createHash('sha256')
      .update(await fs.readFile(entrypoint))
      .digest('hex');
    if (actualBuildDigest.toLowerCase() !== entry.buildDigest.toLowerCase()) {
      throw new Error(`${variant} build digest mismatch: expected ${entry.buildDigest}, got ${actualBuildDigest}`);
    }
  }
  if (entry.runtimeDigest !== undefined) {
    assertTrackedWorktreeClean(canonicalRepo, variant);
    const actualRuntimeDigest = await runtimeDigest(canonicalRepo);
    if (actualRuntimeDigest !== entry.runtimeDigest) {
      throw new Error(`${variant} runtime digest mismatch`);
    }
  }
  return { variant, actualSha, repoPath: canonicalRepo, entrypoint };
}

async function readManifestFromRoot(root) {
  const resolvedRoot = path.resolve(root);
  const manifestPath = path.join(resolvedRoot, 'manifest.json');
  const manifest = validateManifest(JSON.parse(await fs.readFile(manifestPath, 'utf8')));
  if (path.resolve(manifest.benchmarkRoot) !== resolvedRoot) {
    throw new Error('Manifest benchmark root does not match requested root');
  }
  return manifest;
}

export async function readActiveVariant(root) {
  const value = (await fs.readFile(path.join(path.resolve(root), 'active-variant.txt'), 'utf8')).trim();
  if (!VARIANTS.includes(value)) throw new Error(`Unknown active benchmark variant: ${value}`);
  return value;
}

export async function publishNewBenchmarkFiles(root, manifestContent, activeContent = 'prototype\n') {
  const resolvedRoot = path.resolve(root);
  const manifestPath = path.join(resolvedRoot, 'manifest.json');
  const activePath = path.join(resolvedRoot, 'active-variant.txt');
  const suffix = `${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}`;
  const manifestTemp = `${manifestPath}.tmp-${suffix}`;
  const activeTemp = `${activePath}.tmp-${suffix}`;
  let manifestPublished = false;
  let activePublished = false;

  await fs.writeFile(manifestTemp, manifestContent, { encoding: 'utf8', flag: 'wx' });
  try {
    await fs.writeFile(activeTemp, activeContent, { encoding: 'utf8', flag: 'wx' });
    await fs.link(manifestTemp, manifestPath);
    manifestPublished = true;
    await fs.link(activeTemp, activePath);
    activePublished = true;
  } catch (error) {
    if (activePublished) await removePublishedLink(activePath, activeTemp);
    if (manifestPublished) await removePublishedLink(manifestPath, manifestTemp);
    throw error;
  } finally {
    await fs.rm(manifestTemp, { force: true });
    await fs.rm(activeTemp, { force: true });
  }
}

async function removePublishedLink(publishedPath, temporaryPath) {
  let published;
  let temporary;
  try {
    [published, temporary] = await Promise.all([
      fs.lstat(publishedPath),
      fs.lstat(temporaryPath),
    ]);
  } catch (error) {
    if (error?.code === 'ENOENT') return;
    throw error;
  }
  if (published.dev !== temporary.dev || published.ino !== temporary.ino) return;
  try {
    await fs.unlink(publishedPath);
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error;
  }
}
export async function selectVariant(root, variant) {
  if (!VARIANTS.includes(variant)) throw new Error(`Unknown benchmark variant: ${variant}`);
  const resolvedRoot = path.resolve(root);
  const manifest = await readManifestFromRoot(resolvedRoot);
  const verified = await verifyVariant(manifest, variant);
  const target = path.join(resolvedRoot, 'active-variant.txt');
  const temp = path.join(resolvedRoot, `.active-variant.tmp-${process.pid}-${Date.now()}`);
  await fs.writeFile(temp, `${variant}\n`, { encoding: 'utf8', flag: 'wx' });
  try {
    await fs.rename(temp, target);
  } finally {
    await fs.rm(temp, { force: true });
  }
  return verified;
}

function assertSafeId(value, label) {
  if (typeof value !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(value)) {
    throw new Error(`${label} must be a safe benchmark identifier`);
  }
}

function isWithinOrEqual(root, candidate) {
  return path.resolve(root) === path.resolve(candidate) || isWithin(root, candidate);
}

async function assertContainedExistingPath(canonicalRoot, parts, label) {
  let current = canonicalRoot;
  for (const part of parts) {
    current = path.join(current, part);
    let stat;
    try {
      stat = await fs.lstat(current);
    } catch (error) {
      if (error?.code === 'ENOENT') return { path: current, exists: false };
      throw error;
    }
    if (stat.isSymbolicLink()) {
      throw new Error(`${label} must not contain a symlink or reparse point`);
    }
    const realPath = await fs.realpath(current);
    if (!isWithinOrEqual(canonicalRoot, realPath)) {
      throw new Error(`${label} must stay within benchmark root`);
    }
  }
  return { path: current, exists: true };
}

async function assertContainedTree(canonicalRoot, directory, label) {
  const entries = await fs.readdir(directory, { withFileTypes: true });
  for (const entry of entries) {
    const child = path.join(directory, entry.name);
    const stat = await fs.lstat(child);
    if (stat.isSymbolicLink()) {
      throw new Error(`${label} must not contain a symlink or reparse point`);
    }
    const realPath = await fs.realpath(child);
    if (!isWithinOrEqual(canonicalRoot, realPath)) {
      throw new Error(`${label} must stay within benchmark root`);
    }
    if (stat.isDirectory()) await assertContainedTree(canonicalRoot, child, label);
  }
}

export async function resetFixture(root, fixtureId, runId) {
  assertSafeId(fixtureId, 'fixture');
  assertSafeId(runId, 'runId');
  let canonicalRoot;
  try {
    canonicalRoot = await fs.realpath(path.resolve(root));
  } catch {
    throw new Error('benchmark root must resolve to a real filesystem path');
  }
  const sourceCheck = await assertContainedExistingPath(canonicalRoot, ['fixtures', fixtureId], 'fixture source');
  if (!sourceCheck.exists) {
    throw new Error(`fixture does not exist: ${fixtureId}`);
  }
  const source = sourceCheck.path;
  if (!(await fs.lstat(source)).isDirectory()) throw new Error(`fixture does not exist: ${fixtureId}`);
  await assertContainedTree(canonicalRoot, source, 'fixture source');

  const runsCheck = await assertContainedExistingPath(canonicalRoot, ['runs'], 'run workspace');
  if (!runsCheck.exists) {
    await fs.mkdir(runsCheck.path);
  }
  const runCheck = await assertContainedExistingPath(canonicalRoot, ['runs', runId], 'run workspace');
  if (!runCheck.exists) {
    await fs.mkdir(runCheck.path);
  }
  const workspaceCheck = await assertContainedExistingPath(
    canonicalRoot, ['runs', runId, 'workspace'], 'run workspace',
  );
  if (workspaceCheck.exists) {
    throw new Error(`run workspace already exists: ${runId}`);
  }
  const workspace = workspaceCheck.path;
  const gitMarker = path.join(source, '.git');
  try {
    await fs.access(gitMarker);
    const metadataPath = path.join(canonicalRoot, 'fixtures', `${fixtureId}.fixture.json`);
    let metadata;
    try {
      metadata = JSON.parse(await fs.readFile(metadataPath, 'utf8'));
    } catch {
      throw new Error(`Git fixture metadata is required: ${fixtureId}`);
    }
    if (!/^[0-9a-f]{40}$/i.test(metadata?.expectedSha ?? '')) {
      throw new Error(`Git fixture expectedSha must be a full Git SHA: ${fixtureId}`);
    }
    const actualSha = gitHead(source);
    if (actualSha.toLowerCase() !== metadata.expectedSha.toLowerCase()) {
      throw new Error(`Git fixture SHA mismatch: expected ${metadata.expectedSha}, got ${actualSha}`);
    }
    const status = execFileSync('git', ['-C', source, 'status', '--porcelain'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    }).trim();
    if (status !== '') throw new Error(`Git fixture must be clean before reset: ${fixtureId}`);
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error;
  }
  await fs.cp(source, workspace, { recursive: true, errorOnExist: true, force: false });
  return workspace;
}

const SAFE_METADATA_KEYS = [
  'variant', 'expectedSha', 'actualSha', 'buildDigest', 'fixtureId', 'fixtureSha',
  'runId', 'startedAt', 'finishedAt', 'outcome', 'durationMs', 'toolCalls', 'retries',
  'humanInterventions',
];
const OUTCOMES = new Set(['pass', 'fail', 'blocked', 'cancelled', 'error']);

function assertMetadataValue(key, value) {
  if (key === 'variant' && !VARIANTS.includes(value)) throw new Error('variant must be clean or prototype');
  if (['expectedSha', 'actualSha', 'fixtureSha'].includes(key) && !/^[0-9a-f]{40}$/i.test(value ?? '')) {
    throw new Error(`${key} must be a full Git SHA`);
  }
  if (key === 'buildDigest' && !/^[0-9a-f]{64}$/i.test(value ?? '')) throw new Error('buildDigest must be SHA-256 hex');
  if (['fixtureId', 'runId'].includes(key)) assertSafeId(value, key);
  if (['startedAt', 'finishedAt'].includes(key)) {
    if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/.test(value) || Number.isNaN(Date.parse(value))) {
      throw new Error(`${key} must be an ISO-8601 UTC timestamp`);
    }
  }
  if (key === 'outcome' && !OUTCOMES.has(value)) throw new Error(`outcome must be one of: ${[...OUTCOMES].join(', ')}`);
  if (['durationMs', 'toolCalls', 'retries', 'humanInterventions'].includes(key)) {
    if (!Number.isSafeInteger(value) || value < 0) throw new Error(`${key} must be a non-negative integer`);
  }
}

export function safeRunMetadata(input) {
  const output = {};
  for (const key of SAFE_METADATA_KEYS) {
    if (input?.[key] !== undefined) {
      assertMetadataValue(key, input[key]);
      output[key] = input[key];
    }
  }
  return output;
}
