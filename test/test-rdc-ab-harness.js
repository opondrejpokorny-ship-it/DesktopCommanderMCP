import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { validateManifest } from '../scripts/benchmark/rdc-ab/lib.mjs';

function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}

// Runtime identity is the SHA-256 of lexical UTF-8 records:
// <POSIX-relative-file-path>\0<file-SHA-256>\n. Git metadata is excluded.
async function runtimeDigest(root) {
  const records = [];
  async function visit(directory, relative = '') {
    const entries = await fs.readdir(directory, { withFileTypes: true });
    entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    for (const entry of entries) {
      if (relative === '' && entry.name === '.git') continue;
      const childRelative = relative ? path.join(relative, entry.name) : entry.name;
      const childPath = path.join(directory, entry.name);
      if (entry.isDirectory()) {
        await visit(childPath, childRelative);
      } else if (entry.isFile()) {
        records.push(`${childRelative.split(path.sep).join('/')}\0${sha256(await fs.readFile(childPath))}\n`);
      }
    }
  }
  await visit(root);
  return sha256(records.join(''));
}

const valid = {
  schemaVersion: 1,
  benchmarkRoot: 'C:/RDC-Benchmark',
  variants: {
    clean: { repoPath: 'C:/RDC-Benchmark/clean/repo', expectedSha: 'a'.repeat(40) },
    prototype: { repoPath: 'C:/RDC-Benchmark/prototype/repo', expectedSha: 'b'.repeat(40) },
  },
};

assert.equal(validateManifest(valid).schemaVersion, 1);
assert.throws(
  () => validateManifest({ ...valid, schemaVersion: 2 }),
  /schemaVersion/i,
);
assert.throws(
  () => validateManifest({ ...valid, variants: { clean: valid.variants.clean } }),
  /prototype/i,
);
assert.throws(
  () => validateManifest({ ...valid, variants: { ...valid.variants, evil: valid.variants.clean } }),
  /variant/i,
);
console.log('PASS RDC A/B manifest validation');

import fs from 'node:fs/promises';
import { watch } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync, spawn, spawnSync } from 'node:child_process';

function spawnCaptured(file, args, options = {}) {
  const child = spawn(file, args, { windowsHide: true, ...options });
  let stdout = '';
  let stderr = '';
  child.stdout?.on('data', (chunk) => { stdout += chunk; });
  child.stderr?.on('data', (chunk) => { stderr += chunk; });
  const completed = new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('exit', (status, signal) => resolve({ status, signal, stdout, stderr }));
  });
  return { child, completed };
}

async function terminateFakeProcesses(pids) {
  for (const pid of new Set(pids.filter((value) => Number.isInteger(value) && value > 0))) {
    try { process.kill(pid); } catch {}
  }
  await new Promise((resolve) => setTimeout(resolve, 100));
}

async function waitForDirectoryCondition(directory, predicate, processes, label, timeoutMs = 15000) {
  if (await predicate()) return;
  await new Promise((resolve, reject) => {
    let settled = false;
    const directoryWatcher = watch(directory, check);
    const timeout = setTimeout(() => finish(new Error(`Timed out waiting for ${label}`)), timeoutMs);
    const emitters = processes.map(({ child }) => child);

    async function check() {
      if (settled) return;
      try {
        if (await predicate()) finish();
      } catch (error) {
        finish(error);
      }
    }
    function finish(error) {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      directoryWatcher.close();
      for (const emitter of emitters) emitter.off('exit', check);
      if (error) reject(error);
      else resolve();
    }
    for (const emitter of emitters) emitter.on('exit', check);
    void check();
  });
}

async function snapshotTree(root) {
  const snapshot = [];
  async function visit(directory, relative) {
    const entries = await fs.readdir(directory, { withFileTypes: true });
    entries.sort((a, b) => a.name.localeCompare(b.name));
    for (const entry of entries) {
      const childRelative = relative ? path.join(relative, entry.name) : entry.name;
      const childPath = path.join(directory, entry.name);
      if (entry.isDirectory()) {
        snapshot.push(['directory', childRelative]);
        await visit(childPath, childRelative);
      } else if (entry.isFile()) {
        snapshot.push(['file', childRelative, (await fs.readFile(childPath)).toString('base64')]);
      } else {
        snapshot.push(['other', childRelative]);
      }
    }
  }
  await visit(root, '');
  return snapshot;
}

const { verifyVariant } = await import('../scripts/benchmark/rdc-ab/lib.mjs');
const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'rdc-ab-'));
const cleanRepo = path.join(tempRoot, 'clean', 'repo');
const prototypeRepo = path.join(tempRoot, 'prototype', 'repo');

function git(cwd, ...args) {
  return execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8' }).trim();
}
async function makeRepo(repoPath, marker) {
  await fs.mkdir(path.join(repoPath, 'dist'), { recursive: true });
  execFileSync('git', ['init', repoPath]);
  git(repoPath, 'config', 'user.email', 'benchmark@example.invalid');
  git(repoPath, 'config', 'user.name', 'RDC Benchmark');
  await fs.writeFile(path.join(repoPath, 'dist', 'index.js'), marker);
  git(repoPath, 'add', '.');
  git(repoPath, 'commit', '-m', marker);
  return git(repoPath, 'rev-parse', 'HEAD');
}
async function makeRuntimeRepo(repoPath, marker) {
  await fs.mkdir(repoPath, { recursive: true });
  execFileSync('git', ['init', repoPath]);
  git(repoPath, 'config', 'user.email', 'benchmark@example.invalid');
  git(repoPath, 'config', 'user.name', 'RDC Benchmark');
  await fs.writeFile(path.join(repoPath, '.git', 'info', 'exclude'), 'node_modules/\ndist/\n');
  await fs.mkdir(path.join(repoPath, 'dist'), { recursive: true });
  await fs.mkdir(path.join(repoPath, 'node_modules', 'tiny-runtime'), { recursive: true });
  await fs.writeFile(path.join(repoPath, 'dist', 'index.js'), marker);
  await fs.writeFile(path.join(repoPath, 'dist', 'runtime-helper.js'), 'runtime-helper');
  await fs.writeFile(path.join(repoPath, 'node_modules', 'tiny-runtime', 'index.js'), 'tiny-runtime');
  await fs.writeFile(path.join(repoPath, 'package-lock.json'), '{"lockfileVersion":3}\n');
  git(repoPath, 'add', '.');
  git(repoPath, 'commit', '-m', marker);
  return {
    sha: git(repoPath, 'rev-parse', 'HEAD'),
    runtimeDigest: await runtimeDigest(repoPath),
  };
}
const cleanSha = await makeRepo(cleanRepo, 'clean');
const prototypeSha = await makeRepo(prototypeRepo, 'prototype');
const exactManifest = validateManifest({
  schemaVersion: 1,
  benchmarkRoot: tempRoot,
  variants: {
    clean: { repoPath: cleanRepo, expectedSha: cleanSha, buildDigest: sha256('clean') },
    prototype: { repoPath: prototypeRepo, expectedSha: prototypeSha, buildDigest: sha256('prototype') },
  },
});

assert.equal((await verifyVariant(exactManifest, 'clean')).actualSha, cleanSha);
await fs.writeFile(path.join(cleanRepo, 'dist', 'index.js'), 'tampered-clean');
assert.equal(git(cleanRepo, 'rev-parse', 'HEAD'), cleanSha);
await assert.rejects(() => verifyVariant(exactManifest, 'clean'), /build digest mismatch/i);
await fs.writeFile(path.join(cleanRepo, 'dist', 'index.js'), 'clean');
const invalidBuildDigest = structuredClone(exactManifest);
invalidBuildDigest.variants.clean.buildDigest = 'not-a-sha256';
assert.throws(() => validateManifest(invalidBuildDigest), /buildDigest.*SHA-256/i);
const badShaManifest = structuredClone(exactManifest);
badShaManifest.variants.clean.expectedSha = 'f'.repeat(40);
await assert.rejects(() => verifyVariant(badShaManifest, 'clean'), /SHA mismatch/i);
await fs.rm(path.join(cleanRepo, 'dist', 'index.js'));
await assert.rejects(() => verifyVariant(exactManifest, 'clean'), /entrypoint/i);
await fs.writeFile(path.join(cleanRepo, 'dist', 'index.js'), 'clean');

const runtimeRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'rdc-ab-runtime-'));
try {
  const runtimeCleanRepo = path.join(runtimeRoot, 'clean', 'repo');
  const runtimePrototypeRepo = path.join(runtimeRoot, 'prototype', 'repo');
  const runtimeClean = await makeRuntimeRepo(runtimeCleanRepo, 'runtime-clean');
  const runtimePrototype = await makeRuntimeRepo(runtimePrototypeRepo, 'runtime-prototype');
  const runtimeManifest = validateManifest({
    schemaVersion: 1,
    benchmarkRoot: runtimeRoot,
    variants: {
      clean: {
        repoPath: runtimeCleanRepo,
        expectedSha: runtimeClean.sha,
        buildDigest: sha256('runtime-clean'),
        runtimeDigest: runtimeClean.runtimeDigest,
      },
      prototype: {
        repoPath: runtimePrototypeRepo,
        expectedSha: runtimePrototype.sha,
        buildDigest: sha256('runtime-prototype'),
        runtimeDigest: runtimePrototype.runtimeDigest,
      },
    },
  });
  const runtimeEntrypoint = path.join(runtimeCleanRepo, 'dist', 'index.js');
  const originalEntrypoint = await fs.readFile(runtimeEntrypoint);
  const runtimeHelper = path.join(runtimeCleanRepo, 'dist', 'runtime-helper.js');
  const runtimeModule = path.join(runtimeCleanRepo, 'node_modules', 'tiny-runtime', 'index.js');
  const unexpectedRuntimeModule = path.join(runtimeCleanRepo, 'node_modules', 'unexpected', 'index.js');
  const packageLock = path.join(runtimeCleanRepo, 'package-lock.json');

  assert.equal((await verifyVariant(runtimeManifest, 'clean')).actualSha, runtimeClean.sha);

  async function assertRuntimeTamperingFails(label, expectedError, expectTrackedDirty = false) {
    assert.equal(git(runtimeCleanRepo, 'rev-parse', 'HEAD'), runtimeClean.sha, `${label} must not change Git HEAD`);
    assert.deepEqual(await fs.readFile(runtimeEntrypoint), originalEntrypoint,
      `${label} must not change dist/index.js`);
    const trackedStatus = git(runtimeCleanRepo, 'status', '--porcelain');
    if (expectTrackedDirty) assert.notEqual(trackedStatus, '', `${label} must be a tracked-worktree change`);
    else assert.equal(trackedStatus, '', `${label} must remain invisible to Git cleanliness checks`);
    await assert.rejects(
      () => verifyVariant(runtimeManifest, 'clean'),
      expectedError,
      `${label} must fail closed when exact runtime identity changes`,
    );
  }

  await fs.writeFile(runtimeHelper, 'tampered-runtime-helper');
  await assertRuntimeTamperingFails('tampering a non-entry dist file', /runtime digest mismatch/i);
  await fs.writeFile(runtimeHelper, 'runtime-helper');

  await fs.writeFile(runtimeModule, 'tampered-tiny-runtime');
  await assertRuntimeTamperingFails('tampering a node_modules file', /runtime digest mismatch/i);
  await fs.writeFile(runtimeModule, 'tiny-runtime');

  await fs.mkdir(path.dirname(unexpectedRuntimeModule), { recursive: true });
  await fs.writeFile(unexpectedRuntimeModule, 'unexpected-runtime');
  await assertRuntimeTamperingFails('adding an unexpected node_modules file', /runtime digest mismatch/i);
  await fs.rm(path.dirname(unexpectedRuntimeModule), { recursive: true, force: true });

  await fs.rm(runtimeHelper);
  await assertRuntimeTamperingFails('deleting a runtime file', /runtime digest mismatch/i);
  await fs.writeFile(runtimeHelper, 'runtime-helper');

  await fs.writeFile(packageLock, '{"lockfileVersion":999}\n');
  await assertRuntimeTamperingFails('modifying tracked package-lock.json', /tracked worktree differs from HEAD/i, true);
} finally {
  await fs.rm(runtimeRoot, { recursive: true, force: true });
}
console.log('PASS RDC A/B exact runtime-identity verification');

const escaped = structuredClone(exactManifest);
escaped.variants.clean.repoPath = path.dirname(tempRoot);
await assert.rejects(() => verifyVariant(escaped, 'clean'), /benchmark root/i);
const realRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'rdc-ab-realpath-'));
const outsideRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'rdc-ab-outside-'));
const outsideRepo = path.join(outsideRoot, 'repo');
const outsideSha = await makeRepo(outsideRepo, 'outside-repo');
const linkedRepo = path.join(realRoot, 'clean', 'repo');
await fs.mkdir(path.dirname(linkedRepo), { recursive: true });
await fs.symlink(outsideRepo, linkedRepo, process.platform === 'win32' ? 'junction' : 'dir');
const linkedPrototype = path.join(realRoot, 'prototype', 'repo');
const linkedPrototypeSha = await makeRepo(linkedPrototype, 'inside-prototype');
const reparseManifest = {
  schemaVersion: 1,
  benchmarkRoot: realRoot,
  variants: {
    clean: { repoPath: linkedRepo, expectedSha: outsideSha },
    prototype: { repoPath: linkedPrototype, expectedSha: linkedPrototypeSha },
  },
};
await assert.rejects(
  () => verifyVariant(reparseManifest, 'clean'),
  /real path|reparse|benchmark root|outside/i,
  'variant repo must not escape the benchmark root through a junction/symlink',
);
await fs.rm(realRoot, { recursive: true, force: true });
await fs.rm(outsideRoot, { recursive: true, force: true });
console.log('PASS RDC A/B reparse-point repo containment');
console.log('PASS RDC A/B exact-SHA verification');
await fs.rm(tempRoot, { recursive: true, force: true });

const publishModule = await import('../scripts/benchmark/rdc-ab/lib.mjs');
assert.equal(typeof publishModule.publishNewBenchmarkFiles, 'function',
  'benchmark initialization needs a no-clobber publish helper');
const publishHelperRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'rdc-ab-init-publish-'));
const foreignActiveBytes = Buffer.from([0x46, 0x4f, 0x52, 0x45, 0x49, 0x47, 0x4e, 0x00, 0xff]);
await fs.writeFile(path.join(publishHelperRoot, 'active-variant.txt'), foreignActiveBytes);
await assert.rejects(
  () => publishModule.publishNewBenchmarkFiles(
    publishHelperRoot,
    JSON.stringify({ schemaVersion: 1 }),
    'prototype\n',
  ),
  /exist|publish|active/i,
);
assert.deepEqual(
  await fs.readFile(path.join(publishHelperRoot, 'active-variant.txt')),
  foreignActiveBytes,
  'failed initialization must preserve a concurrently-created foreign active pointer byte-for-byte',
);
await assert.rejects(() => fs.access(path.join(publishHelperRoot, 'manifest.json')),
  /ENOENT|no such file/i,
  'failed initialization must remove only its own manifest publication');
await fs.rm(publishHelperRoot, { recursive: true, force: true });
console.log('PASS RDC A/B init-manifest no-clobber publish contract');

const publishReplacementRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'rdc-ab-init-replacement-'));
const replacementManifestPath = path.join(publishReplacementRoot, 'manifest.json');
const replacementActivePath = path.join(publishReplacementRoot, 'active-variant.txt');
const replacementBytes = Buffer.from('replacement written after publication');
await fs.writeFile(replacementActivePath, 'foreign active pointer');
const originalLink = fs.link;
try {
  fs.link = async (existingPath, publishedPath) => {
    await originalLink(existingPath, publishedPath);
    if (publishedPath === replacementManifestPath) {
      const foreignPath = path.join(publishReplacementRoot, 'foreign-manifest');
      await fs.writeFile(foreignPath, replacementBytes);
      await fs.rm(replacementManifestPath);
      await fs.rename(foreignPath, replacementManifestPath);
    }
  };
  await assert.rejects(
    () => publishModule.publishNewBenchmarkFiles(publishReplacementRoot, '{"published":true}'),
    /exist|publish|active/i,
  );
} finally {
  fs.link = originalLink;
}
assert.deepEqual(
  await fs.readFile(replacementManifestPath),
  replacementBytes,
  'rollback must not delete a manifest replaced after this invocation published it',
);
await fs.rm(publishReplacementRoot, { recursive: true, force: true });
console.log('PASS RDC A/B init-manifest replacement-safe rollback');
const { selectVariant, readActiveVariant } = await import('../scripts/benchmark/rdc-ab/lib.mjs');
const selectRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'rdc-ab-select-'));
const selectClean = path.join(selectRoot, 'clean', 'repo');
const selectPrototype = path.join(selectRoot, 'prototype', 'repo');
const selectCleanSha = await makeRepo(selectClean, 'select-clean');
const selectPrototypeSha = await makeRepo(selectPrototype, 'select-prototype');
const selectManifest = {
  schemaVersion: 1,
  benchmarkRoot: selectRoot,
  variants: {
    clean: { repoPath: selectClean, expectedSha: selectCleanSha, buildDigest: sha256('select-clean') },
    prototype: {
      repoPath: selectPrototype,
      expectedSha: selectPrototypeSha,
      buildDigest: sha256('select-prototype'),
    },
  },
};
await fs.writeFile(path.join(selectRoot, 'manifest.json'), JSON.stringify(selectManifest));
await fs.writeFile(path.join(selectRoot, 'active-variant.txt'), 'prototype\n');
const mismatch = structuredClone(selectManifest);
mismatch.variants.clean.expectedSha = 'e'.repeat(40);
await fs.writeFile(path.join(selectRoot, 'manifest.json'), JSON.stringify(mismatch));
await assert.rejects(() => selectVariant(selectRoot, 'clean'), /SHA mismatch/i);
assert.equal(await readActiveVariant(selectRoot), 'prototype');
await fs.writeFile(path.join(selectRoot, 'manifest.json'), JSON.stringify(selectManifest));
await fs.writeFile(path.join(selectClean, 'dist', 'index.js'), 'tampered-select-clean');
assert.equal(git(selectClean, 'rev-parse', 'HEAD'), selectCleanSha);
await assert.rejects(() => selectVariant(selectRoot, 'clean'), /build digest mismatch/i);
assert.equal(await readActiveVariant(selectRoot), 'prototype');
await fs.writeFile(path.join(selectClean, 'dist', 'index.js'), 'select-clean');
await selectVariant(selectRoot, 'clean');
assert.equal(await readActiveVariant(selectRoot), 'clean');
const leftovers = (await fs.readdir(selectRoot)).filter((name) => name.includes('.tmp-'));
assert.deepEqual(leftovers, []);
console.log('PASS RDC A/B fail-closed atomic selection');
await fs.rm(selectRoot, { recursive: true, force: true });

if (process.env.RDC_AB_TEST_CASE === 'build-digest') {
  console.log('PASS RDC A/B focused build-digest cases');
  process.exit(0);
}

const { resetFixture, safeRunMetadata } = await import('../scripts/benchmark/rdc-ab/lib.mjs');
const fixtureRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'rdc-ab-fixture-'));
const template = path.join(fixtureRoot, 'fixtures', 'coding-01');
await fs.mkdir(template, { recursive: true });
await fs.writeFile(path.join(template, 'README.md'), 'immutable template');
const workspace = await resetFixture(fixtureRoot, 'coding-01', 'run-001');
assert.equal(await fs.readFile(path.join(workspace, 'README.md'), 'utf8'), 'immutable template');
await fs.writeFile(path.join(workspace, 'README.md'), 'changed run');
assert.equal(await fs.readFile(path.join(template, 'README.md'), 'utf8'), 'immutable template');
await assert.rejects(() => resetFixture(fixtureRoot, '../escape', 'run-002'), /fixture/i);
await assert.rejects(() => resetFixture(fixtureRoot, 'coding-01', '../escape'), /runId/i);
await assert.rejects(() => resetFixture(fixtureRoot, 'coding-01', 'run-001'), /already exists/i);
const fixtureEscapeRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'rdc-ab-fixture-escape-'));
const fixtureEscapeOutside = await fs.mkdtemp(path.join(os.tmpdir(), 'rdc-ab-fixture-outside-'));
const escapedFixture = path.join(fixtureEscapeRoot, 'fixtures', 'escaped');
await fs.mkdir(path.dirname(escapedFixture), { recursive: true });
await fs.writeFile(path.join(fixtureEscapeOutside, 'outside.txt'), 'do not copy');
await fs.symlink(fixtureEscapeOutside, escapedFixture, process.platform === 'win32' ? 'junction' : 'dir');
await assert.rejects(
  () => resetFixture(fixtureEscapeRoot, 'escaped', 'source-escape'),
  /symlink|reparse|fixture|outside/i,
);
await assert.rejects(() => fs.access(path.join(fixtureEscapeRoot, 'runs', 'source-escape')), /ENOENT|no such file/i);
const fixtureAncestorRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'rdc-ab-fixture-ancestor-'));
const fixtureAncestorOutside = await fs.mkdtemp(path.join(os.tmpdir(), 'rdc-ab-fixture-ancestor-outside-'));
await fs.mkdir(path.join(fixtureAncestorOutside, 'ancestor'));
await fs.writeFile(path.join(fixtureAncestorOutside, 'ancestor', 'outside.txt'), 'do not copy');
await fs.symlink(
  fixtureAncestorOutside,
  path.join(fixtureAncestorRoot, 'fixtures'),
  process.platform === 'win32' ? 'junction' : 'dir',
);
await assert.rejects(
  () => resetFixture(fixtureAncestorRoot, 'ancestor', 'ancestor-escape'),
  /symlink|reparse|fixture|outside/i,
);
await assert.rejects(() => fs.access(path.join(fixtureAncestorRoot, 'runs')), /ENOENT|no such file/i);
await fs.rm(fixtureAncestorRoot, { recursive: true, force: true });
await fs.rm(fixtureAncestorOutside, { recursive: true, force: true });
const escapedRun = path.join(fixtureEscapeRoot, 'runs', 'workspace-escape');
await fs.mkdir(path.dirname(escapedRun), { recursive: true });
await fs.symlink(fixtureEscapeOutside, escapedRun, process.platform === 'win32' ? 'junction' : 'dir');
await fs.mkdir(path.join(fixtureEscapeRoot, 'fixtures', 'safe'), { recursive: true });
await fs.writeFile(path.join(fixtureEscapeRoot, 'fixtures', 'safe', 'inside.txt'), 'inside');
await assert.rejects(
  () => resetFixture(fixtureEscapeRoot, 'safe', 'workspace-escape'),
  /symlink|reparse|workspace|outside/i,
);
await assert.rejects(() => fs.access(path.join(fixtureEscapeOutside, 'workspace')), /ENOENT|no such file/i);
await fs.rm(fixtureEscapeRoot, { recursive: true, force: true });
await fs.rm(fixtureEscapeOutside, { recursive: true, force: true });
console.log('PASS RDC A/B fixture reset rejects reparse-point ancestors');
const safe = safeRunMetadata({
  variant: 'prototype', actualSha: 'b'.repeat(40), runId: 'run-001',
  durationMs: 123, toolCalls: 7, rawCommand: 'secret command', fileContents: 'secret',
});
assert.deepEqual(safe, {
  variant: 'prototype', actualSha: 'b'.repeat(40), runId: 'run-001',
  durationMs: 123, toolCalls: 7,
});
assert.equal(JSON.stringify(safe).includes('secret'), false);
console.log('PASS RDC A/B fixture reset and privacy-safe metadata');
await fs.rm(fixtureRoot, { recursive: true, force: true });

const cliRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'rdc-ab-cli-'));
const cliClean = path.join(cliRoot, 'clean', 'repo');
const cliPrototype = path.join(cliRoot, 'prototype', 'repo');
const cliCleanSha = await makeRepo(cliClean, 'cli-clean');
const cliPrototypeSha = await makeRepo(cliPrototype, 'cli-prototype');
await fs.writeFile(path.join(cliRoot, 'manifest.json'), JSON.stringify({
  schemaVersion: 1, benchmarkRoot: cliRoot,
  variants: {
    clean: { repoPath: cliClean, expectedSha: cliCleanSha },
    prototype: { repoPath: cliPrototype, expectedSha: cliPrototypeSha },
  },
}));
await fs.writeFile(path.join(cliRoot, 'active-variant.txt'), 'prototype\n');
const cliPath = path.resolve('scripts/benchmark/rdc-ab/cli.mjs');
const unknown = spawnSync(process.execPath, [cliPath, 'unknown', '--root', cliRoot], { encoding: 'utf8' });
assert.notEqual(unknown.status, 0);
assert.match(unknown.stderr, /unknown command/i);
const statusRun = spawnSync(process.execPath, [cliPath, 'status', '--root', cliRoot], { encoding: 'utf8' });
assert.equal(statusRun.status, 0, statusRun.stderr);
const parsedStatus = JSON.parse(statusRun.stdout);
assert.equal(parsedStatus.selected, 'prototype');
assert.equal(parsedStatus.prototype.actualSha, cliPrototypeSha);
const selectRun = spawnSync(process.execPath, [cliPath, 'select', 'clean', '--root', cliRoot], { encoding: 'utf8' });
assert.equal(selectRun.status, 0, selectRun.stderr);
assert.equal(await readActiveVariant(cliRoot), 'clean');
const verifyRun = spawnSync(process.execPath, [cliPath, 'verify', 'clean', '--root', cliRoot], { encoding: 'utf8' });
assert.equal(verifyRun.status, 0, verifyRun.stderr);
assert.equal(JSON.parse(verifyRun.stdout).actualSha, cliCleanSha);
console.log('PASS RDC A/B CLI contract');
await fs.rm(cliRoot, { recursive: true, force: true });

if (process.platform === 'win32') {
  const setupSandbox = await fs.mkdtemp(path.join(os.tmpdir(), 'rdc-ab-setup-'));
  try {
    const sourceClean = path.join(setupSandbox, 'source-clean');
    const sourcePrototype = path.join(setupSandbox, 'source-prototype');
    const sourceCleanSha = await makeRepo(sourceClean, 'setup-clean');
    const sourcePrototypeSha = await makeRepo(sourcePrototype, 'setup-prototype');
    const preparedRoot = path.join(setupSandbox, 'prepared');
    const setupScript = path.resolve('scripts/benchmark/rdc-ab/Setup-RdcAb.ps1');
    const setupArgs = [
      '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', setupScript,
      '-BenchmarkRoot', preparedRoot,
      '-CleanSource', sourceClean, '-CleanSha', sourceCleanSha,
      '-PrototypeSource', sourcePrototype, '-PrototypeSha', sourcePrototypeSha,
      '-UpstreamLatestObserved', sourceCleanSha, '-SkipInstallBuild',
    ];
    const setupEnvironment = { ...process.env };
    delete setupEnvironment.RDC_AB_ENABLE_TEST_CONTROL;
    delete setupEnvironment.RDC_AB_TEST_CONTROL_DIRECTORY;
    const setupRun = spawnSync('powershell.exe', setupArgs, {
      encoding: 'utf8', env: setupEnvironment,
    });
    assert.equal(setupRun.status, 0, `${setupRun.stdout}\n${setupRun.stderr}`);
    const preparedManifest = JSON.parse(await fs.readFile(path.join(preparedRoot, 'manifest.json'), 'utf8'));
    assert.equal(preparedManifest.variants.clean.expectedSha, sourceCleanSha);
    assert.equal(preparedManifest.variants.prototype.expectedSha, sourcePrototypeSha);
    assert.equal(preparedManifest.variants.clean.runtimeDigest,
      await runtimeDigest(path.join(preparedRoot, 'clean', 'repo')));
    assert.equal(preparedManifest.variants.prototype.runtimeDigest,
      await runtimeDigest(path.join(preparedRoot, 'prototype', 'repo')));
    assert.equal((await fs.readFile(path.join(preparedRoot, 'active-variant.txt'), 'utf8')).trim(), 'prototype');
    assert.equal(git(path.join(preparedRoot, 'clean', 'repo'), 'rev-parse', 'HEAD'), sourceCleanSha);
    assert.equal(git(path.join(preparedRoot, 'prototype', 'repo'), 'rev-parse', 'HEAD'), sourcePrototypeSha);
    const duplicateRun = spawnSync('powershell.exe', setupArgs, {
      encoding: 'utf8', env: setupEnvironment,
    });
    assert.notEqual(duplicateRun.status, 0);
    assert.match(`${duplicateRun.stdout}\n${duplicateRun.stderr}`, /already exists/i);
    const failedRoot = path.join(setupSandbox, 'failed');
    const failedArgs = setupArgs.map((value) => value === preparedRoot ? failedRoot : value);
    const cleanShaIndex = failedArgs.indexOf('-CleanSha') + 1;
    failedArgs[cleanShaIndex] = 'f'.repeat(40);
    const failedRun = spawnSync('powershell.exe', failedArgs, {
      encoding: 'utf8', env: setupEnvironment,
    });
    assert.notEqual(failedRun.status, 0);
    await assert.rejects(() => fs.access(failedRoot));

    const disabledControl = path.join(setupSandbox, 'disabled-control');
    const disabledRoot = path.join(setupSandbox, 'disabled-target');
    const disabledSentinel = Buffer.from([0x00, 0x01, 0x7f, 0x80, 0xfe, 0xff]);
    await fs.mkdir(disabledControl);
    await fs.mkdir(disabledRoot);
    await fs.writeFile(path.join(disabledRoot, 'sentinel.bin'), disabledSentinel);
    const disabledArgs = setupArgs.map((value) => value === preparedRoot ? disabledRoot : value);
    const disabledRun = spawnSync('powershell.exe', disabledArgs, {
      encoding: 'utf8',
      env: { ...setupEnvironment, RDC_AB_TEST_CONTROL_DIRECTORY: disabledControl },
    });
    assert.notEqual(disabledRun.status, 0);
    assert.match(`${disabledRun.stdout}\n${disabledRun.stderr}`, /setup test control is disabled/i);
    assert.deepEqual(await fs.readFile(path.join(disabledRoot, 'sentinel.bin')), disabledSentinel);

    const publishRoot = path.join(setupSandbox, 'publish-race');
    const publishControl = path.join(setupSandbox, 'publish-control');
    const publishSentinel = Buffer.from([0xff, 0x00, 0x45, 0x4e, 0x44, 0x0d, 0x0a]);
    await fs.mkdir(publishControl);
    const publishArgs = setupArgs.map((value) => value === preparedRoot ? publishRoot : value);
    const publishingSetup = spawnCaptured('powershell.exe', publishArgs, {
      env: {
        ...setupEnvironment,
        RDC_AB_ENABLE_TEST_CONTROL: '1',
        RDC_AB_TEST_CONTROL_DIRECTORY: publishControl,
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    try {
      await waitForDirectoryCondition(
        publishControl,
        async () => fs.access(path.join(publishControl, 'ready')).then(() => true, () => false)
          || publishingSetup.child.exitCode !== null,
        [publishingSetup],
        'setup publish barrier',
      );
      assert.equal(
        publishingSetup.child.exitCode,
        null,
        `setup exited before publish barrier: ${publishingSetup.child.exitCode}`,
      );
      const stagePrefix = `.${path.basename(publishRoot)}.stage-`;
      const stagesBeforePublish = (await fs.readdir(setupSandbox))
        .filter((name) => name.startsWith(stagePrefix));
      assert.equal(stagesBeforePublish.length, 1, 'setup must own exactly one unpublished stage');

      await fs.mkdir(publishRoot);
      await fs.writeFile(path.join(publishRoot, 'sentinel.bin'), publishSentinel);
      const foreignTargetSnapshot = await snapshotTree(publishRoot);
      await fs.writeFile(path.join(publishControl, 'release'), '');
      const publishRun = await publishingSetup.completed;
      assert.notEqual(publishRun.status, 0, `${publishRun.stdout}\n${publishRun.stderr}`);
      assert.equal(
        await fs.stat(publishRoot).then((entry) => entry.isDirectory(), () => false),
        true,
        'setup deleted a concurrently-created foreign benchmark root',
      );
      assert.deepEqual(await snapshotTree(publishRoot), foreignTargetSnapshot);
      assert.deepEqual(await fs.readFile(path.join(publishRoot, 'sentinel.bin')), publishSentinel);
      const stagesAfterFailure = (await fs.readdir(setupSandbox))
        .filter((name) => name.startsWith(stagePrefix));
      assert.deepEqual(stagesAfterFailure, [], 'setup did not clean its owned stage');
    } finally {
      await fs.writeFile(path.join(publishControl, 'release'), '').catch(() => {});
      if (publishingSetup.child.exitCode === null) publishingSetup.child.kill();
      await publishingSetup.completed.catch(() => {});
    }
    console.log('PASS RDC A/B Windows provisioning and publish-race contract');
  } finally {
    await fs.rm(setupSandbox, { recursive: true, force: true });
  }
  if (process.env.RDC_AB_TEST_CASE === 'setup-publish') {
    console.log('PASS RDC A/B focused setup-publish cases');
    process.exit(0);
  }
} else {
  console.log('SKIP RDC A/B Windows provisioning contract (non-Windows)');
}

if (process.platform === 'win32') {
  const hostSandbox = await fs.mkdtemp(path.join(os.tmpdir(), 'rdc-ab-host-'));
  const hostRoot = path.join(hostSandbox, 'benchmark');
  const hostClean = path.join(hostRoot, 'clean', 'repo');
  const hostPrototype = path.join(hostRoot, 'prototype', 'repo');
  const hostCleanSha = await makeRepo(hostClean, 'host-clean');
  const hostPrototypeSha = await makeRepo(hostPrototype, 'host-prototype');
  const hostCleanRuntimeDigest = await runtimeDigest(hostClean);
  const hostPrototypeRuntimeDigest = await runtimeDigest(hostPrototype);
  await fs.mkdir(path.join(hostRoot, 'state', 'prototype'), { recursive: true });
  await fs.writeFile(path.join(hostRoot, 'manifest.json'), JSON.stringify({
    schemaVersion: 1, benchmarkRoot: hostRoot,
    variants: {
      clean: { repoPath: hostClean, expectedSha: hostCleanSha, runtimeDigest: hostCleanRuntimeDigest },
      prototype: {
        repoPath: hostPrototype, expectedSha: hostPrototypeSha, runtimeDigest: hostPrototypeRuntimeDigest,
        statePaths: {
          policyFile: path.join(hostRoot, 'state', 'prototype', 'policy.json'),
          approvalFile: path.join(hostRoot, 'state', 'prototype', 'approvals.json'),
          auditFile: path.join(hostRoot, 'state', 'prototype', 'audit.jsonl'),
          usageFile: path.join(hostRoot, 'state', 'prototype', 'usage.json'),
          workflowStateDir: path.join(hostRoot, 'state', 'prototype', 'workflow'),
        },
      },
    },
  }));
  await fs.writeFile(path.join(hostRoot, 'active-variant.txt'), 'prototype\n');
  const launcher = path.join(hostSandbox, 'start-remote.cmd');
  const originalLauncher = '@echo off\r\necho ORIGINAL\r\n';
  await fs.writeFile(launcher, originalLauncher);
  const installer = path.resolve('scripts/benchmark/rdc-ab/Install-RdcAbLauncher.ps1');
  const installArgs = [
    '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', installer,
    '-BenchmarkRoot', hostRoot, '-LauncherPath', launcher,
  ];
  const missingRoot = path.join(hostSandbox, 'missing');
  const missingRun = spawnSync('powershell.exe', [
    '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', installer,
    '-BenchmarkRoot', missingRoot, '-LauncherPath', launcher,
  ], { encoding: 'utf8' });
  assert.notEqual(missingRun.status, 0);
  assert.equal(await fs.readFile(launcher, 'utf8'), originalLauncher);
  await assert.rejects(() => fs.access(`${launcher}.rdc-ab-original`));

  const installRun = spawnSync('powershell.exe', installArgs, { encoding: 'utf8' });
  assert.equal(installRun.status, 0, `${installRun.stdout}\n${installRun.stderr}`);
  assert.equal(await fs.readFile(`${launcher}.rdc-ab-original`, 'utf8'), originalLauncher);
  const delegator = await fs.readFile(launcher, 'utf8');
  assert.match(delegator, /Run-RdcAbSupervisor\.ps1/i);
  assert.doesNotMatch(delegator, /clean[\\/]repo|prototype[\\/]repo/i);
  await fs.writeFile(launcher, '@echo off\r\necho TAMPERED-INSTALLED\r\n');
  const reinstallRun = spawnSync('powershell.exe', installArgs, { encoding: 'utf8' });
  assert.equal(reinstallRun.status, 0, `${reinstallRun.stdout}\n${reinstallRun.stderr}`);
  assert.equal(await fs.readFile(`${launcher}.rdc-ab-original`, 'utf8'), originalLauncher);
  assert.match(await fs.readFile(launcher, 'utf8'), /Run-RdcAbSupervisor\.ps1/i);
  console.log('PASS RDC A/B launcher installer contract');

  const installMutationControl = path.join(hostSandbox, 'install-mutation-control');
  await fs.mkdir(installMutationControl);
  await fs.writeFile(path.join(installMutationControl, 'hold-install'), '');
  const installMutationEnvironment = {
    ...process.env,
    RDC_AB_ENABLE_TEST_CONTROL: '1',
    RDC_AB_TEST_CONTROL_DIRECTORY: installMutationControl,
  };
  const heldInstall = spawnCaptured('powershell.exe', installArgs, {
    env: installMutationEnvironment, stdio: ['ignore', 'pipe', 'pipe'],
  });
  await waitForDirectoryCondition(
    installMutationControl,
    async () => fs.access(path.join(installMutationControl, 'install-ready')).then(() => true, () => false)
      || heldInstall.child.exitCode !== null,
    [heldInstall], 'install mutation mutex hold',
  );
  assert.equal(heldInstall.child.exitCode, null, 'install exited before holding mutation mutex');
  const racedInstall = spawnSync('powershell.exe', installArgs, {
    encoding: 'utf8', env: installMutationEnvironment,
  });
  assert.notEqual(racedInstall.status, 0);
  assert.match(`${racedInstall.stdout}\n${racedInstall.stderr}`, /launcher mutation.+active/i);
  const racedInstallRestore = spawnSync('powershell.exe', [
    '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', path.resolve('scripts/benchmark/rdc-ab/Restore-RdcAbLauncher.ps1'),
    '-BenchmarkRoot', hostRoot, '-LauncherPath', launcher,
  ], { encoding: 'utf8', env: installMutationEnvironment });
  assert.notEqual(racedInstallRestore.status, 0);
  assert.match(`${racedInstallRestore.stdout}\n${racedInstallRestore.stderr}`, /launcher mutation.+active/i);
  await fs.writeFile(path.join(installMutationControl, 'install-release'), '');
  const heldInstallResult = await heldInstall.completed;
  assert.equal(heldInstallResult.status, 0, `${heldInstallResult.stdout}\n${heldInstallResult.stderr}`);
  assert.equal(await fs.readFile(`${launcher}.rdc-ab-original`, 'utf8'), originalLauncher);
  console.log('PASS RDC A/B install mutation serialization and backup preservation');

  const supervisor = path.resolve('scripts/benchmark/rdc-ab/Run-RdcAbSupervisor.ps1');
  const validate = (root) => spawnSync('powershell.exe', [
    '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', supervisor,
    '-BenchmarkRoot', root, '-ValidateOnly',
  ], { encoding: 'utf8' });
  let validation = validate(hostRoot);
  assert.equal(validation.status, 0, `${validation.stdout}\n${validation.stderr}`);
  let validationJson = JSON.parse(validation.stdout.trim());
  assert.equal(validationJson.variant, 'prototype');
  assert.equal(validationJson.actualSha, hostPrototypeSha);
  assert.equal(validationJson.prototypeStateInjected, true);
  await fs.rm(path.join(hostRoot, 'state', 'prototype'), { recursive: true, force: true });
  validation = validate(hostRoot);
  assert.equal(validation.status, 0, `${validation.stdout}\n${validation.stderr}`);
  await assert.rejects(
    () => fs.access(path.join(hostRoot, 'state', 'prototype')),
    /ENOENT|no such file/i,
  );

  await fs.writeFile(path.join(hostRoot, 'active-variant.txt'), 'clean\n');
  validation = validate(hostRoot);
  assert.equal(validation.status, 0, `${validation.stdout}\n${validation.stderr}`);
  validationJson = JSON.parse(validation.stdout.trim());
  assert.equal(validationJson.variant, 'clean');
  assert.equal(validationJson.actualSha, hostCleanSha);
  assert.equal(validationJson.prototypeStateInjected, false);
  const outsideStateRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'rdc-ab-outside-state-'));
  await fs.rm(path.join(hostRoot, 'state'), { recursive: true, force: true });
  await fs.symlink(
    outsideStateRoot,
    path.join(hostRoot, 'state'),
    'junction',
  );
  await fs.writeFile(path.join(hostRoot, 'active-variant.txt'), 'prototype\n');
  validation = validate(hostRoot);
  assert.notEqual(validation.status, 0);
  assert.match(`${validation.stdout}\n${validation.stderr}`, /real path|benchmark root|state/i);
  await fs.rmdir(path.join(hostRoot, 'state'));
  await fs.rm(outsideStateRoot, { recursive: true, force: true });
  await fs.writeFile(path.join(hostRoot, 'active-variant.txt'), 'clean\n');
  console.log('PASS RDC A/B supervisor reparse-point state containment');

  const hostManifestPath = path.join(hostRoot, 'manifest.json');
  const hostManifest = JSON.parse(await fs.readFile(hostManifestPath, 'utf8'));
  const badHostManifest = structuredClone(hostManifest);
  badHostManifest.variants.clean.expectedSha = 'f'.repeat(40);
  await fs.writeFile(hostManifestPath, JSON.stringify(badHostManifest));
  validation = validate(hostRoot);
  assert.notEqual(validation.status, 0);
  assert.match(`${validation.stdout}\n${validation.stderr}`, /SHA mismatch/i);
  await fs.writeFile(hostManifestPath, JSON.stringify(hostManifest));

  await fs.rm(path.join(hostClean, 'dist', 'index.js'));
  validation = validate(hostRoot);
  assert.notEqual(validation.status, 0);
  assert.match(`${validation.stdout}\n${validation.stderr}`, /entrypoint/i);
  await fs.writeFile(path.join(hostClean, 'dist', 'index.js'), 'host-clean');
  await fs.writeFile(path.join(hostRoot, 'active-variant.txt'), 'evil\n');
  validation = validate(hostRoot);
  assert.notEqual(validation.status, 0);
  assert.match(`${validation.stdout}\n${validation.stderr}`, /active|variant/i);
  console.log('PASS RDC A/B supervisor validation contract');

  if (process.env.RDC_AB_TEST_CASE !== 'handoff') {
    await fs.writeFile(path.join(hostRoot, 'active-variant.txt'), 'clean\n');
    const raceControl = path.join(hostSandbox, 'supervisor-race-control');
    await fs.mkdir(raceControl);
    const raceArgs = [
      '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', supervisor,
      '-BenchmarkRoot', hostRoot, '-TestControlDirectory', raceControl,
    ];
    const raceEnvironment = { ...process.env, RDC_AB_ENABLE_TEST_CONTROL: '1' };
    const firstSupervisor = spawnCaptured('powershell.exe', raceArgs, {
      env: raceEnvironment, stdio: ['ignore', 'pipe', 'pipe'],
    });
    const secondSupervisor = spawnCaptured('powershell.exe', raceArgs, {
      env: raceEnvironment, stdio: ['ignore', 'pipe', 'pipe'],
    });
    const supervisors = [firstSupervisor, secondSupervisor];
    const readyOrExcluded = async () => {
      const names = await fs.readdir(raceControl);
      return names.filter((name) => name.startsWith('ready-')).length === 2
        || supervisors.some(({ child }) => child.exitCode !== null);
    };
    await waitForDirectoryCondition(
      raceControl, readyOrExcluded, supervisors, 'both launch decisions or one excluded supervisor',
    );
    await fs.writeFile(path.join(raceControl, 'release'), '');
    const raceResults = await Promise.all(supervisors.map(({ completed }) => completed));
    const launchAuthorities = (await fs.readdir(raceControl))
      .filter((name) => name.startsWith('launch-'));
    assert.equal(
      launchAuthorities.length,
      1,
      `expected one launch authority, got ${launchAuthorities.length}; statuses=${raceResults.map((run) => run.status).join(',')}`,
    );
    assert.equal(raceResults.filter((run) => run.status === 0).length, 1);
    assert.match(
      raceResults.find((run) => run.status !== 0)?.stderr ?? '',
      /supervisor.+already active|already active.+supervisor/i,
    );
    console.log('PASS RDC A/B cross-process supervisor exclusion');

    await fs.rm(path.join(hostRoot, 'logs'), { recursive: true, force: true });
    await fs.rm(path.join(hostRoot, 'state', 'prototype'), { recursive: true, force: true });
    await fs.writeFile(path.join(hostRoot, 'active-variant.txt'), 'prototype\n');
    const beforeValidation = await snapshotTree(hostRoot);
    const validationRuns = Array.from({ length: 4 }, () => spawnCaptured('powershell.exe', [
      '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', supervisor,
      '-BenchmarkRoot', hostRoot, '-ValidateOnly',
    ], { stdio: ['ignore', 'pipe', 'pipe'] }));
    const validationResults = await Promise.all(validationRuns.map(({ completed }) => completed));
    for (const result of validationResults) {
      assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
      assert.equal(JSON.parse(result.stdout.trim()).variant, 'prototype');
    }
    assert.deepEqual(await snapshotTree(hostRoot), beforeValidation);
    console.log('PASS RDC A/B concurrent ValidateOnly is side-effect-free');
  }

  const restore = path.resolve('scripts/benchmark/rdc-ab/Restore-RdcAbLauncher.ps1');
  const restoreArgs = [
    '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', restore,
    '-BenchmarkRoot', hostRoot, '-LauncherPath', launcher,
  ];
  await fs.writeFile(path.join(hostRoot, 'active-variant.txt'), 'clean\n');
  const refusedRestore = spawnSync('powershell.exe', restoreArgs, { encoding: 'utf8' });
  assert.notEqual(refusedRestore.status, 0);
  assert.match(`${refusedRestore.stdout}\n${refusedRestore.stderr}`, /prototype/i);
  assert.match(await fs.readFile(launcher, 'utf8'), /Run-RdcAbSupervisor\.ps1/i);

  await fs.writeFile(path.join(hostRoot, 'active-variant.txt'), 'prototype\n');
  const restoreControl = path.join(hostSandbox, 'restore-control');
  await fs.mkdir(restoreControl);
  const holdingSupervisor = spawnCaptured('powershell.exe', [
    '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', supervisor,
    '-BenchmarkRoot', hostRoot, '-TestControlDirectory', restoreControl,
  ], {
    env: { ...process.env, RDC_AB_ENABLE_TEST_CONTROL: '1' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  await waitForDirectoryCondition(
    restoreControl,
    async () => (await fs.readdir(restoreControl)).some((name) => name.startsWith('ready-')),
    [holdingSupervisor],
    'the supervisor to hold restore ownership',
  );
  const activeRestore = spawnSync('powershell.exe', restoreArgs, {
    encoding: 'utf8',
    env: {
      ...process.env,
      RDC_AB_ENABLE_TEST_CONTROL: '1',
      RDC_AB_TEST_CONTROL_DIRECTORY: restoreControl,
    },
  });
  assert.notEqual(activeRestore.status, 0);
  assert.match(`${activeRestore.stdout}\n${activeRestore.stderr}`, /supervisor is active/i);
  assert.match(await fs.readFile(launcher, 'utf8'), /Run-RdcAbSupervisor\.ps1/i);
  await fs.writeFile(path.join(restoreControl, 'release'), '');
  const holdingResult = await holdingSupervisor.completed;
  assert.equal(holdingResult.status, 0, `${holdingResult.stdout}\n${holdingResult.stderr}`);

  const restoreRun = spawnSync('powershell.exe', restoreArgs, { encoding: 'utf8' });
  assert.equal(restoreRun.status, 0, `${restoreRun.stdout}\n${restoreRun.stderr}`);
  assert.equal(await fs.readFile(launcher, 'utf8'), originalLauncher);

  // A backup alone must not authorize overwriting a launcher subsequently claimed
  // by another install. This is RED until restore authenticates its delegator.
  const foreignLauncher = '@echo off\r\necho FOREIGN-INSTALL\r\n';
  const reinstallForOwnership = spawnSync('powershell.exe', installArgs, { encoding: 'utf8' });
  assert.equal(reinstallForOwnership.status, 0, `${reinstallForOwnership.stdout}\n${reinstallForOwnership.stderr}`);
  await fs.writeFile(launcher, foreignLauncher);
  const foreignRestore = spawnSync('powershell.exe', restoreArgs, { encoding: 'utf8' });
  assert.notEqual(foreignRestore.status, 0);
  assert.match(`${foreignRestore.stdout}\n${foreignRestore.stderr}`, /launcher.+(owned|delegator|install)/i);
  assert.equal(await fs.readFile(launcher, 'utf8'), foreignLauncher);
  console.log('PASS RDC A/B restore refuses a foreign launcher');
  console.log('PASS RDC A/B launcher restore contract');
  await fs.rm(hostSandbox, { recursive: true, force: true });
} else {
  console.log('SKIP RDC A/B host launcher/supervisor contracts (non-Windows)');
}

if (process.platform === 'win32' && process.env.RDC_AB_TEST_CASE !== 'mutex') {
  const handoffSandbox = await fs.mkdtemp(path.join(os.tmpdir(), 'rdc-ab-handoff-'));
  const handoffRoot = path.join(handoffSandbox, 'RDC-Benchmark-test');
  const handoffClean = path.join(handoffRoot, 'clean', 'repo');
  const handoffPrototype = path.join(handoffRoot, 'prototype', 'repo');
  const handoffCleanSha = await makeRepo(handoffClean, 'handoff-clean');
  const handoffPrototypeSha = await makeRepo(handoffPrototype, 'handoff-prototype');
  const handoffCleanRuntimeDigest = await runtimeDigest(handoffClean);
  const handoffPrototypeRuntimeDigest = await runtimeDigest(handoffPrototype);
  const signals = path.join(handoffSandbox, 'signals');
  await fs.mkdir(signals);
  await fs.writeFile(path.join(signals, 'release'), '');
  await fs.writeFile(path.join(signals, 'known-remote'), '');
  await fs.mkdir(path.join(handoffRoot, 'state', 'prototype'), { recursive: true });
  await fs.writeFile(path.join(handoffRoot, 'manifest.json'), JSON.stringify({
    schemaVersion: 1, benchmarkRoot: handoffRoot,
    variants: {
      clean: { repoPath: handoffClean, expectedSha: handoffCleanSha, runtimeDigest: handoffCleanRuntimeDigest },
      prototype: {
        repoPath: handoffPrototype, expectedSha: handoffPrototypeSha,
        runtimeDigest: handoffPrototypeRuntimeDigest,
        statePaths: {
          policyFile: path.join(handoffRoot, 'state', 'prototype', 'policy.json'),
          approvalFile: path.join(handoffRoot, 'state', 'prototype', 'approvals.json'),
          auditFile: path.join(handoffRoot, 'state', 'prototype', 'audit.jsonl'),
          usageFile: path.join(handoffRoot, 'state', 'prototype', 'usage.json'),
          workflowStateDir: path.join(handoffRoot, 'state', 'prototype', 'workflow'),
        },
      },
    },
  }));
  await fs.writeFile(path.join(handoffRoot, 'active-variant.txt'), 'prototype\n');

  const canonicalRepo = path.join(handoffSandbox, 'DesktopCommanderTierPrototype');
  const canonicalEntrypoint = path.join(canonicalRepo, 'dist', 'index.js');
  await fs.mkdir(path.dirname(canonicalEntrypoint), { recursive: true });
  const oldInstancesPath = path.join(signals, 'old-instances.txt');
  const oldChildSource = [
    "const fs = require('node:fs');",
    `const instances = ${JSON.stringify(oldInstancesPath)};`,
    `const signals = ${JSON.stringify(signals)};`,
    "fs.appendFileSync(instances, `${process.pid}\\n`);",
    "const instance = fs.readFileSync(instances, 'utf8').trim().split(/\\r?\\n/).length;",
    "const release = `${signals}\\\\release-old-${instance}`;",
    "const sleeper = new Int32Array(new SharedArrayBuffer(4));",
    "while (!fs.existsSync(release)) Atomics.wait(sleeper, 0, 0, 25);",
    "if (instance === 1) fs.rmSync(`${signals}\\\\known-remote`, { force: true });",
    "fs.writeFileSync(`${signals}\\\\old-exit-${instance}`, '');",
  ].join('\r\n');
  await fs.writeFile(canonicalEntrypoint, oldChildSource);
  const handoffLauncher = path.join(handoffSandbox, 'start-remote.cmd');
  const originalWatcher = [
    '@echo off',
    ':loop',
    `"${process.execPath}" "${canonicalEntrypoint}" remote`,
    'goto loop',
    '',
  ].join('\r\n');
  await fs.writeFile(handoffLauncher, originalWatcher);

  const oldWatcher = spawnCaptured(process.env.ComSpec ?? 'cmd.exe', [
    '/d', '/s', '/c', handoffLauncher,
  ], { stdio: ['ignore', 'pipe', 'pipe'] });
  const decoyWatcher = spawnCaptured(process.env.ComSpec ?? 'cmd.exe', [
    '/d', '/q', '/k',
  ], { stdio: ['pipe', 'pipe', 'pipe'] });
  let activatedWrapperPid;
  let originalChildPid;
  let unrelatedRemotePid;
  try {
    await waitForDirectoryCondition(
      signals,
      async () => fs.access(oldInstancesPath).then(() => true, () => false),
      [oldWatcher],
      'the fake canonical RDC child',
    );
    originalChildPid = Number((await fs.readFile(oldInstancesPath, 'utf8')).trim());
    assert.ok(Number.isInteger(originalChildPid) && originalChildPid > 0);

    const handoffInstaller = path.resolve('scripts/benchmark/rdc-ab/Install-RdcAbLauncher.ps1');
    const installHandoff = spawnSync('powershell.exe', [
      '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', handoffInstaller,
      '-BenchmarkRoot', handoffRoot, '-LauncherPath', handoffLauncher,
    ], { encoding: 'utf8' });
    assert.equal(installHandoff.status, 0, `${installHandoff.stdout}\n${installHandoff.stderr}`);
    assert.equal(await fs.readFile(`${handoffLauncher}.rdc-ab-original`, 'utf8'), originalWatcher);
    const exactWatcherInventory = {
      Name: 'cmd.exe',
      ProcessId: oldWatcher.child.pid,
      CommandLine: `cmd.exe /d /s /c ""${handoffLauncher}""`,
    };
    const decoyWatcherInventory = {
      Name: 'cmd.exe',
      ProcessId: decoyWatcher.child.pid,
      CommandLine: 'cmd.exe /d /q /k',
    };
    const inventoryPath = path.join(signals, 'process-inventory.json');
    await fs.writeFile(inventoryPath, JSON.stringify([
      exactWatcherInventory,
      { ...exactWatcherInventory },
      decoyWatcherInventory,
    ]));

    const activation = path.resolve('scripts/benchmark/rdc-ab/Activate-RdcAbLauncher.ps1');
    const activationArgs = [
      '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', activation,
      '-BenchmarkRoot', handoffRoot, '-LauncherPath', handoffLauncher,
    ];
    const activationOptions = {
      encoding: 'utf8',
      env: {
        ...process.env,
        RDC_AB_ENABLE_TEST_CONTROL: '1',
        RDC_AB_TEST_CONTROL_DIRECTORY: signals,
      },
    };

    // A launcher path embedded in /k, or followed by a cmd operator, is not an
    // exact watcher invocation. This is RED until activation rejects all of them.
    const unavailableCommandProcessor = path.join(signals, 'unavailable-cmd.exe');
    await fs.writeFile(unavailableCommandProcessor, 'not a Windows executable');
    const prelaunchActivationOptions = {
      ...activationOptions,
      env: { ...activationOptions.env, ComSpec: unavailableCommandProcessor },
    };
    for (const unsafeCommandLine of [
      `cmd.exe /d /q /k ""${handoffLauncher}""`,
      `cmd.exe /d /s /c ""${handoffLauncher}"" & echo injected`,
      `cmd.exe /d /s /c ""${handoffLauncher}"" && echo injected`,
      `cmd.exe /d /s /c ""${handoffLauncher}"" || echo injected`,
      `cmd.exe /d /s /c ""${handoffLauncher}"" | more`,
      `cmd.exe /d /s /c ""${handoffLauncher}"" > nul`,
    ]) {
      await fs.writeFile(inventoryPath, JSON.stringify([{
        ...exactWatcherInventory,
        CommandLine: unsafeCommandLine,
      }]));
      const unsafeWatcherActivation = spawnSync('powershell.exe', activationArgs, prelaunchActivationOptions);
      assert.notEqual(unsafeWatcherActivation.status, 0, unsafeCommandLine);
      assert.match(
        `${unsafeWatcherActivation.stdout}\n${unsafeWatcherActivation.stderr}`,
        /watcher.+(exact|unsafe|command)/i,
        unsafeCommandLine,
      );
      assert.doesNotThrow(() => process.kill(oldWatcher.child.pid, 0), unsafeCommandLine);
    }
    console.log('PASS RDC A/B activation rejects /k and trailing watcher commands');

    // This genuine remote is unrelated to the canonical entrypoint. The fixture
    // also records that it is not a child of the old watcher for the test seam.
    const unrelatedRemote = spawnCaptured(process.execPath, [
      '-e', 'Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 60000)', 'remote',
    ], { stdio: ['ignore', 'pipe', 'pipe'] });
    unrelatedRemotePid = unrelatedRemote.child.pid;
    await fs.writeFile(path.join(signals, 'remote-process-inventory.json'), JSON.stringify([{
      Name: 'node.exe',
      ProcessId: unrelatedRemotePid,
      ParentProcessId: 0,
      CommandLine: `"${process.execPath}" -e "unrelated remote" remote`,
    }]));
    await fs.writeFile(inventoryPath, JSON.stringify([exactWatcherInventory]));
    const unrelatedRemoteActivation = spawnSync('powershell.exe', activationArgs, prelaunchActivationOptions);
    assert.notEqual(unrelatedRemoteActivation.status, 0);
    assert.match(
      `${unrelatedRemoteActivation.stdout}\n${unrelatedRemoteActivation.stderr}`,
      /exact.+live.+RDC.+child|remote.+(canonical|watcher|entrypoint)/i,
    );
    assert.doesNotThrow(() => process.kill(oldWatcher.child.pid, 0));
    console.log('PASS RDC A/B activation requires the exact old-watcher remote child');

    // The existing hold is reached only after ValidateOnly. Mutating here makes
    // validation-to-launch integrity deterministic rather than timing-sensitive.
    await fs.writeFile(path.join(signals, 'hold-activation'), '');
    const toctouActivation = spawnCaptured('powershell.exe', activationArgs, {
      env: activationOptions.env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    await waitForDirectoryCondition(
      signals,
      async () => fs.access(path.join(signals, 'activation-ready')).then(() => true, () => false)
        || toctouActivation.child.exitCode !== null,
      [toctouActivation], 'activation validation before launcher TOCTOU mutation',
    );
    assert.equal(toctouActivation.child.exitCode, null, 'activation exited before its post-validation hold');
    await fs.writeFile(handoffLauncher, '@echo off\r\nexit /b 0\r\n');
    await fs.writeFile(path.join(signals, 'activation-release'), '');
    const toctouResult = await toctouActivation.completed;
    assert.notEqual(toctouResult.status, 0);
    assert.match(
      `${toctouResult.stdout}\n${toctouResult.stderr}`,
      /launcher.+(changed|mutation)|verified.+bytes/i,
    );
    assert.doesNotThrow(() => process.kill(oldWatcher.child.pid, 0));
    await fs.rm(path.join(signals, 'hold-activation'));
    await fs.rm(path.join(signals, 'activation-release'));
    const restoreDelegator = spawnSync('powershell.exe', [
      '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', handoffInstaller,
      '-BenchmarkRoot', handoffRoot, '-LauncherPath', handoffLauncher,
    ], { encoding: 'utf8' });
    assert.equal(restoreDelegator.status, 0, `${restoreDelegator.stdout}\n${restoreDelegator.stderr}`);
    console.log('PASS RDC A/B activation closes validation-to-launch TOCTOU');
    const ambiguousActivation = spawnSync('powershell.exe', activationArgs, activationOptions);
    assert.notEqual(ambiguousActivation.status, 0);
    assert.match(`${ambiguousActivation.stdout}\n${ambiguousActivation.stderr}`, /multiple.+watcher/i);
    assert.doesNotThrow(() => process.kill(oldWatcher.child.pid, 0));

    await fs.writeFile(inventoryPath, JSON.stringify([
      exactWatcherInventory,
      decoyWatcherInventory,
    ]));

    await fs.writeFile(path.join(signals, 'hold-install'), '');
    const heldHandoffInstall = spawnCaptured('powershell.exe', [
      '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', handoffInstaller,
      '-BenchmarkRoot', handoffRoot, '-LauncherPath', handoffLauncher,
    ], { env: activationOptions.env, stdio: ['ignore', 'pipe', 'pipe'] });
    await waitForDirectoryCondition(
      signals,
      async () => fs.access(path.join(signals, 'install-ready')).then(() => true, () => false)
        || heldHandoffInstall.child.exitCode !== null,
      [heldHandoffInstall], 'install mutation mutex hold before activation',
    );
    assert.equal(heldHandoffInstall.child.exitCode, null, 'install exited before holding mutation mutex');
    const racedInstallActivation = spawnSync('powershell.exe', activationArgs, activationOptions);
    assert.notEqual(racedInstallActivation.status, 0);
    assert.match(`${racedInstallActivation.stdout}\n${racedInstallActivation.stderr}`, /launcher mutation.+active/i);
    assert.doesNotThrow(() => process.kill(oldWatcher.child.pid, 0));
    await fs.writeFile(path.join(signals, 'install-release'), '');
    const heldHandoffInstallResult = await heldHandoffInstall.completed;
    assert.equal(heldHandoffInstallResult.status, 0, `${heldHandoffInstallResult.stdout}\n${heldHandoffInstallResult.stderr}`);
    await fs.rm(path.join(signals, 'hold-install'));
    console.log('PASS RDC A/B install and activation are mutation-serialized');

    const invalidCommandProcessor = path.join(signals, 'invalid-cmd.exe');
    await fs.writeFile(invalidCommandProcessor, 'not a Windows executable');
    const failedStartActivation = spawnSync('powershell.exe', activationArgs, {
      ...activationOptions,
      env: { ...activationOptions.env, ComSpec: invalidCommandProcessor },
    });
    assert.notEqual(failedStartActivation.status, 0);
    assert.match(`${failedStartActivation.stdout}\n${failedStartActivation.stderr}`, /start|process|executable|application/i);
    assert.doesNotThrow(
      () => process.kill(oldWatcher.child.pid, 0),
      'old watcher must survive replacement-launch failure',
    );
    console.log('PASS RDC A/B failed replacement launch preserves old watcher');

    await fs.writeFile(path.join(signals, 'watcher-exit-or-change-before-retirement'), '');
    const staleWatcherActivation = spawnSync('powershell.exe', activationArgs, activationOptions);
    assert.notEqual(staleWatcherActivation.status, 0);
    assert.match(
      `${staleWatcherActivation.stdout}\n${staleWatcherActivation.stderr}`,
      /watcher.+(exited|changed).+retirement/i,
    );
    assert.doesNotThrow(
      () => process.kill(oldWatcher.child.pid, 0),
      'watcher must survive an identity change detected before retirement',
    );
    await fs.rm(path.join(signals, 'watcher-exit-or-change-before-retirement'));
    console.log('PASS RDC A/B stale watcher identity fails closed');

    const handoffRestore = path.resolve('scripts/benchmark/rdc-ab/Restore-RdcAbLauncher.ps1');
    await fs.writeFile(path.join(signals, 'hold-activation'), '');
    const heldActivation = spawnCaptured('powershell.exe', activationArgs, {
      env: activationOptions.env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    await waitForDirectoryCondition(
      signals,
      async () => fs.access(path.join(signals, 'activation-ready')).then(() => true, () => false)
        || heldActivation.child.exitCode !== null,
      [heldActivation],
      'activation mutation mutex hold',
    );
    assert.equal(heldActivation.child.exitCode, null, 'activation exited before holding mutation mutex');
    const racedRestore = spawnSync('powershell.exe', [
      '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', handoffRestore,
      '-BenchmarkRoot', handoffRoot, '-LauncherPath', handoffLauncher,
    ], {
      encoding: 'utf8',
      env: activationOptions.env,
    });
    assert.notEqual(racedRestore.status, 0);
    assert.match(`${racedRestore.stdout}\n${racedRestore.stderr}`, /launcher mutation.+active/i);
    assert.match(await fs.readFile(handoffLauncher, 'utf8'), /Run-RdcAbSupervisor\.ps1/i);
    await fs.writeFile(path.join(signals, 'activation-release'), '');
    const activateRun = await heldActivation.completed;
    assert.equal(activateRun.status, 0, `${activateRun.stdout}\n${activateRun.stderr}`);
    const activationResult = JSON.parse(activateRun.stdout.trim());
    console.log('PASS RDC A/B activation and restore are mutation-serialized');
    activatedWrapperPid = activationResult.startedWrapperPid;
    assert.equal(activationResult.stoppedWatcherPid, oldWatcher.child.pid);
    assert.equal(activationResult.variant, 'prototype');
    assert.equal(decoyWatcher.child.exitCode, null);
    await waitForDirectoryCondition(
      signals,
      async () => {
        try {
          process.kill(oldWatcher.child.pid, 0);
          return false;
        } catch {
          return true;
        }
      },
      [oldWatcher],
      'the exact old watcher to exit',
    );
    assert.doesNotThrow(() => process.kill(originalChildPid, 0));
    const signalsBeforeOldChildExit = await fs.readdir(signals);
    assert.equal(
      signalsBeforeOldChildExit.some((name) => name.startsWith('launch-')),
      false,
      signalsBeforeOldChildExit.join(','),
    );

    await fs.writeFile(path.join(signals, 'release-old-1'), '');
    await waitForDirectoryCondition(
      signals,
      async () => {
        const names = await fs.readdir(signals);
        return names.includes('old-exit-1') && names.some((name) => name.startsWith('launch-'));
      },
      [],
      'the old child exit and installed supervisor launch authority',
    );
    assert.equal((await fs.readFile(oldInstancesPath, 'utf8')).trim().split(/\r?\n/).length, 1);
    console.log('PASS RDC A/B canonical watcher activation handoff');
  } finally {
    await fs.writeFile(path.join(signals, 'release-old-1'), '').catch(() => {});
    await fs.writeFile(path.join(signals, 'release-old-2'), '').catch(() => {});
    if (oldWatcher.child.exitCode === null) oldWatcher.child.kill();
    if (decoyWatcher.child.exitCode === null) decoyWatcher.child.kill();
    if (Number.isInteger(activatedWrapperPid)) {
      try { process.kill(activatedWrapperPid); } catch {}
    }
    if (Number.isInteger(originalChildPid)) {
      await waitForDirectoryCondition(
        signals,
        async () => fs.access(path.join(signals, 'old-exit-1')).then(() => true, () => false),
        [],
        'the fake canonical child to exit during cleanup',
        5000,
      ).catch(() => {});
    }
    const fakeRemotePids = await fs.readFile(oldInstancesPath, 'utf8')
      .then((value) => value.trim().split(/\r?\n/).map(Number), () => []);
    fakeRemotePids.push(unrelatedRemotePid);
    await terminateFakeProcesses(fakeRemotePids);
    await fs.rm(handoffSandbox, { recursive: true, force: true }).catch(() => {});
  }
} else if (process.platform !== 'win32') {
  console.log('SKIP RDC A/B canonical watcher activation handoff (non-Windows)');
}

const cliExtraRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'rdc-ab-cli-extra-'));
const extraClean = path.join(cliExtraRoot, 'clean', 'repo');
const extraPrototype = path.join(cliExtraRoot, 'prototype', 'repo');
const extraCleanSha = await makeRepo(extraClean, 'extra-clean');
const extraPrototypeSha = await makeRepo(extraPrototype, 'extra-prototype');
const initRun = spawnSync(process.execPath, [
  cliPath, 'init-manifest', '--root', cliExtraRoot,
  '--clean-repo', extraClean, '--clean-sha', extraCleanSha,
  '--prototype-repo', extraPrototype, '--prototype-sha', extraPrototypeSha,
  '--upstream-latest', extraCleanSha,
], { encoding: 'utf8' });
assert.equal(initRun.status, 0, initRun.stderr);
const initialized = JSON.parse(await fs.readFile(path.join(cliExtraRoot, 'manifest.json'), 'utf8'));
assert.equal(initialized.variants.clean.expectedSha, extraCleanSha);
assert.equal((await fs.readFile(path.join(cliExtraRoot, 'active-variant.txt'), 'utf8')).trim(), 'prototype');

const extraFixture = path.join(cliExtraRoot, 'fixtures', 'tiny');
await fs.mkdir(extraFixture, { recursive: true });
await fs.writeFile(path.join(extraFixture, 'README.md'), 'tiny fixture');
const resetRun = spawnSync(process.execPath, [
  cliPath, 'reset-fixture', 'tiny', 'extra-run', '--root', cliExtraRoot,
], { encoding: 'utf8' });
assert.equal(resetRun.status, 0, resetRun.stderr);
assert.equal(await fs.readFile(path.join(cliExtraRoot, 'runs', 'extra-run', 'workspace', 'README.md'), 'utf8'), 'tiny fixture');
const invalidCliRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'rdc-ab-cli-invalid-'));
await fs.writeFile(path.join(invalidCliRoot, 'manifest.json'), JSON.stringify({ schemaVersion: 2 }));
await fs.writeFile(path.join(invalidCliRoot, 'active-variant.txt'), 'prototype\n');
const invalidStatus = spawnSync(process.execPath, [
  cliPath, 'status', '--root', invalidCliRoot,
], { encoding: 'utf8' });
assert.notEqual(invalidStatus.status, 0);
assert.match(invalidStatus.stderr, /schemaVersion/i);
console.log('PASS RDC A/B extended CLI contract');
await fs.rm(cliExtraRoot, { recursive: true, force: true });
await fs.rm(invalidCliRoot, { recursive: true, force: true });

assert.deepEqual(safeRunMetadata({
  variant: 'clean', expectedSha: 'a'.repeat(40), buildDigest: 'b'.repeat(64),
  fixtureId: 'fixture-01', fixtureSha: 'c'.repeat(40), runId: 'run-02',
  startedAt: '2026-09-07T08:00:00.000Z', finishedAt: '2026-09-07T08:01:00.000Z',
  outcome: 'pass', durationMs: 60000, toolCalls: 5, retries: 1, humanInterventions: 0,
}), {
  variant: 'clean', expectedSha: 'a'.repeat(40), buildDigest: 'b'.repeat(64),
  fixtureId: 'fixture-01', fixtureSha: 'c'.repeat(40), runId: 'run-02',
  startedAt: '2026-09-07T08:00:00.000Z', finishedAt: '2026-09-07T08:01:00.000Z',
  outcome: 'pass', durationMs: 60000, toolCalls: 5, retries: 1, humanInterventions: 0,
});
assert.throws(
  () => safeRunMetadata({ variant: 'prototype', runId: 'run-03', outcome: 'failed: secret command text' }),
  /outcome/i,
);
assert.throws(
  () => safeRunMetadata({ variant: 'prototype', runId: 'run-04', toolCalls: -1 }),
  /toolCalls/i,
);
console.log('PASS RDC A/B metadata value validation');
const gitFixtureRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'rdc-ab-git-fixture-'));
const gitFixture = path.join(gitFixtureRoot, 'fixtures', 'git-01');
await fs.mkdir(gitFixture, { recursive: true });
execFileSync('git', ['init', gitFixture]);
git(gitFixture, 'config', 'user.email', 'benchmark@example.invalid');
git(gitFixture, 'config', 'user.name', 'RDC Benchmark');
await fs.writeFile(path.join(gitFixture, 'README.md'), 'git fixture');
git(gitFixture, 'add', '.');
git(gitFixture, 'commit', '-m', 'fixture baseline');
const gitFixtureSha = git(gitFixture, 'rev-parse', 'HEAD');
await fs.writeFile(
  path.join(gitFixtureRoot, 'fixtures', 'git-01.fixture.json'),
  JSON.stringify({ expectedSha: gitFixtureSha }),
);
const gitWorkspace = await resetFixture(gitFixtureRoot, 'git-01', 'git-run-01');
assert.equal(git(gitWorkspace, 'rev-parse', 'HEAD'), gitFixtureSha);
assert.equal(git(gitWorkspace, 'status', '--porcelain'), '');
await fs.writeFile(path.join(gitFixture, 'UNTRACKED.txt'), 'must fail');
await assert.rejects(
  () => resetFixture(gitFixtureRoot, 'git-01', 'git-run-02'),
  /clean|untracked|status/i,
);
