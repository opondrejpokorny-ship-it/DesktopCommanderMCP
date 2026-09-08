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
    clean: { repoPath: 'C:/RDC-Benchmark/clean/repo', expectedSha: 'a'.repeat(40), runtimeDigest: 'c'.repeat(64) },
    prototype: { repoPath: 'C:/RDC-Benchmark/prototype/repo', expectedSha: 'b'.repeat(40), runtimeDigest: 'd'.repeat(64) },
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
assert.throws(
  () => validateManifest({ ...valid, variants: { ...valid.variants, clean: { ...valid.variants.clean, runtimeDigest: undefined } } }),
  /runtimeDigest/i,
);
console.log('PASS RDC A/B manifest validation');

import fs from 'node:fs/promises';
import { watch } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const benchmarkScriptsDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../scripts/benchmark/rdc-ab');
import { execFileSync, spawn, spawnSync } from 'node:child_process';

if (process.platform === 'win32') {
  const orchestratorFocused = spawnSync('powershell.exe', [
    '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File',
    path.resolve(path.dirname(fileURLToPath(import.meta.url)), 'helpers/rdc-ab-orchestrator.ps1'),
  ], { encoding: 'utf8' });
  assert.equal(orchestratorFocused.status, 0, orchestratorFocused.stdout + '\\n' + orchestratorFocused.stderr);
  assert.match(orchestratorFocused.stdout, /PASS RDC A\/B orchestrator preflight/);
}

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
function windowsProcessCreationIso(pid) {
  const script = [
    `$p = Get-CimInstance Win32_Process -Filter "ProcessId=${pid}"`,
    `if ($null -eq $p) { exit 2 }`,
    `$p.CreationDate.ToUniversalTime().ToString('o')`,
  ].join('; ');
  return execFileSync('powershell.exe', ['-NoProfile', '-Command', script], {
    encoding: 'utf8', windowsHide: true,
  }).trim();
}
function windowsAclSummary(target) {
  const script = `
$acl = Get-Acl -LiteralPath $env:RDC_AB_ACL_TARGET
$owner = $acl.GetOwner([Security.Principal.SecurityIdentifier]).Value
$trusted = @($owner, 'S-1-5-18', 'S-1-5-32-544')
$mask = [System.Security.AccessControl.FileSystemRights]::Write -bor
  [System.Security.AccessControl.FileSystemRights]::Delete -bor
  [System.Security.AccessControl.FileSystemRights]::DeleteSubdirectoriesAndFiles -bor
  [System.Security.AccessControl.FileSystemRights]::ChangePermissions -bor
  [System.Security.AccessControl.FileSystemRights]::TakeOwnership
$unsafe = @($acl.GetAccessRules($true, $true, [Security.Principal.SecurityIdentifier]) | Where-Object {
  $_.AccessControlType -eq [Security.AccessControl.AccessControlType]::Allow -and
  $_.IdentityReference.Value -notin $trusted -and
  (($_.FileSystemRights -band $mask) -ne 0)
} | ForEach-Object { $_.IdentityReference.Value } | Sort-Object -Unique)
[ordered]@{ protected = $acl.AreAccessRulesProtected; ownerSid = $owner; unsafeWriteSids = $unsafe } |
  ConvertTo-Json -Compress
`;
  const stdout = execFileSync('powershell.exe', ['-NoProfile', '-Command', script], {
    encoding: 'utf8', windowsHide: true,
    env: { ...process.env, RDC_AB_ACL_TARGET: target },
  }).trim();
  return JSON.parse(stdout);
}
function protectBenchmarkRootForTest(target) {
  const script = `
$target = [IO.Path]::GetFullPath($env:RDC_AB_ACL_TARGET)
$current = [Security.Principal.WindowsIdentity]::GetCurrent().User
$acl = New-Object Security.AccessControl.DirectorySecurity
$acl.SetOwner($current)
$acl.SetAccessRuleProtection($true, $false)
$inherit = [Security.AccessControl.InheritanceFlags]::ContainerInherit -bor [Security.AccessControl.InheritanceFlags]::ObjectInherit
foreach ($sidText in @($current.Value, 'S-1-5-18', 'S-1-5-32-544') | Select-Object -Unique) {
  $sid = New-Object Security.Principal.SecurityIdentifier($sidText)
  $rule = New-Object Security.AccessControl.FileSystemAccessRule(
    $sid, [Security.AccessControl.FileSystemRights]::FullControl, $inherit,
    [Security.AccessControl.PropagationFlags]::None, [Security.AccessControl.AccessControlType]::Allow)
  [void]$acl.AddAccessRule($rule)
}
([IO.DirectoryInfo](Get-Item -LiteralPath $target -Force)).SetAccessControl($acl)
foreach ($child in Get-ChildItem -LiteralPath $target -Force) {
  & icacls.exe $child.FullName /reset /T /C /Q | Out-Null
  if ($LASTEXITCODE -ne 0) { throw "icacls reset failed for $($child.FullName)" }
}
`;
  execFileSync('powershell.exe', ['-NoProfile', '-Command', script], {
    encoding: 'utf8', windowsHide: true,
    env: { ...process.env, RDC_AB_ACL_TARGET: target },
  });
}
function grantAuthenticatedUsersModify(target) {
  execFileSync('icacls.exe', [target, '/grant', '*S-1-5-11:M', '/Q'], {
    encoding: 'utf8', windowsHide: true,
  });
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
async function makeSetupBuildRepo(repoPath, marker) {
  await fs.mkdir(path.join(repoPath, 'dist'), { recursive: true });
  execFileSync('git', ['init', repoPath]);
  git(repoPath, 'config', 'user.email', 'benchmark@example.invalid');
  git(repoPath, 'config', 'user.name', 'RDC Benchmark');
  const packageName = `rdc-ab-${marker}`;
  await fs.writeFile(path.join(repoPath, 'dist', 'index.js'), marker);
  await fs.writeFile(path.join(repoPath, 'build.cjs'), "console.log('SETUP_BUILD_STDOUT');\n");
  await fs.writeFile(path.join(repoPath, 'package.json'), JSON.stringify({
    name: packageName, version: '1.0.0', scripts: { build: 'node build.cjs' },
  }));
  await fs.writeFile(path.join(repoPath, 'package-lock.json'), JSON.stringify({
    name: packageName, version: '1.0.0', lockfileVersion: 3, requires: true,
    packages: { '': { name: packageName, version: '1.0.0' } },
  }));
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
    clean: { repoPath: cleanRepo, expectedSha: cleanSha, buildDigest: sha256('clean'), runtimeDigest: await runtimeDigest(cleanRepo) },
    prototype: { repoPath: prototypeRepo, expectedSha: prototypeSha, buildDigest: sha256('prototype'), runtimeDigest: await runtimeDigest(prototypeRepo) },
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
    clean: { repoPath: linkedRepo, expectedSha: outsideSha, runtimeDigest: 'e'.repeat(64) },
    prototype: { repoPath: linkedPrototype, expectedSha: linkedPrototypeSha, runtimeDigest: 'f'.repeat(64) },
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
    clean: { repoPath: selectClean, expectedSha: selectCleanSha, buildDigest: sha256('select-clean'), runtimeDigest: await runtimeDigest(selectClean) },
    prototype: {
      repoPath: selectPrototype,
      expectedSha: selectPrototypeSha,
      buildDigest: sha256('select-prototype'),
      runtimeDigest: await runtimeDigest(selectPrototype),
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
    clean: { repoPath: cliClean, expectedSha: cliCleanSha, runtimeDigest: await runtimeDigest(cliClean) },
    prototype: { repoPath: cliPrototype, expectedSha: cliPrototypeSha, runtimeDigest: await runtimeDigest(cliPrototype) },
  },
}));
await fs.writeFile(path.join(cliRoot, 'active-variant.txt'), 'prototype\n');
const cliPath = path.join(benchmarkScriptsDir, 'cli.mjs');
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

if (process.platform === 'win32' && process.env.RDC_AB_TEST_CASE !== 'handoff-only') {
  const setupSandbox = await fs.mkdtemp(path.join(os.tmpdir(), 'rdc-ab-setup-'));
  try {
    const sourceClean = path.join(setupSandbox, 'source-clean');
    const sourcePrototype = path.join(setupSandbox, 'source-prototype');
    const sourceCleanSha = await makeRepo(sourceClean, 'setup-clean');
    const sourcePrototypeSha = await makeRepo(sourcePrototype, 'setup-prototype');
    const preparedRoot = path.join(setupSandbox, 'prepared');
    const setupScript = path.join(benchmarkScriptsDir, 'Setup-RdcAb.ps1');
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

    const buildSourceClean = path.join(setupSandbox, 'build-source-clean');
    const buildSourcePrototype = path.join(setupSandbox, 'build-source-prototype');
    const buildSourceCleanSha = await makeSetupBuildRepo(buildSourceClean, 'setup-build-clean');
    const buildSourcePrototypeSha = await makeSetupBuildRepo(buildSourcePrototype, 'setup-build-prototype');
    const buildPreparedRoot = path.join(setupSandbox, 'build-prepared');
    const buildSetupArgs = [
      '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', setupScript,
      '-BenchmarkRoot', buildPreparedRoot,
      '-CleanSource', buildSourceClean, '-CleanSha', buildSourceCleanSha,
      '-PrototypeSource', buildSourcePrototype, '-PrototypeSha', buildSourcePrototypeSha,
      '-UpstreamLatestObserved', buildSourceCleanSha,
    ];
    const buildSetupRun = spawnSync('powershell.exe', buildSetupArgs, {
      encoding: 'utf8', env: setupEnvironment,
    });
    assert.equal(buildSetupRun.status, 0, `${buildSetupRun.stdout}\n${buildSetupRun.stderr}`);
    assert.match(buildSetupRun.stdout, /SETUP_BUILD_STDOUT/,
      'setup fixture must prove native build stdout was emitted');
    assert.equal(JSON.parse(buildSetupRun.stdout.trim().split(/\r?\n/).at(-1)).schemaVersion, 1);
    await fs.rm(buildPreparedRoot, { recursive: true, force: true });
    console.log('PASS RDC A/B setup keeps native command stdout out of structured return values');

    const setupRun = spawnSync('powershell.exe', setupArgs, {
      encoding: 'utf8', env: setupEnvironment,
    });
    assert.equal(setupRun.status, 0, `${setupRun.stdout}\n${setupRun.stderr}`);
    const preparedAcl = windowsAclSummary(preparedRoot);
    assert.equal(preparedAcl.protected, true, 'setup must publish a protected benchmark-root DACL');
    assert.deepEqual(preparedAcl.unsafeWriteSids, [], 'setup must remove untrusted benchmark-root write grants');
    const setupSupervisor = path.join(benchmarkScriptsDir, 'Run-RdcAbSupervisor.ps1');
    const validatePrepared = () => spawnSync('powershell.exe', [
      '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', setupSupervisor,
      '-BenchmarkRoot', preparedRoot, '-ValidateOnly',
    ], { encoding: 'utf8' });
    let preparedValidation = validatePrepared();
    assert.equal(preparedValidation.status, 0, `${preparedValidation.stdout}\n${preparedValidation.stderr}`);
    grantAuthenticatedUsersModify(preparedRoot);
    preparedValidation = validatePrepared();
    assert.notEqual(preparedValidation.status, 0);
    assert.match(`${preparedValidation.stdout}\n${preparedValidation.stderr}`, /ACL|permission|security boundary|untrusted|protected/i);
    protectBenchmarkRootForTest(preparedRoot);

    const preparedEntrypoint = path.join(preparedRoot, 'prototype', 'repo', 'dist', 'index.js');
    grantAuthenticatedUsersModify(preparedEntrypoint);
    preparedValidation = validatePrepared();
    assert.notEqual(preparedValidation.status, 0);
    assert.match(`${preparedValidation.stdout}\n${preparedValidation.stderr}`, /ACL|permission|untrusted|runtime|child/i);
    execFileSync('icacls.exe', [preparedEntrypoint, '/reset', '/Q'], { encoding: 'utf8', windowsHide: true });
    preparedValidation = validatePrepared();
    assert.equal(preparedValidation.status, 0, `${preparedValidation.stdout}\n${preparedValidation.stderr}`);
    console.log('PASS RDC A/B supervisor rejects unsafe descendant runtime ACL');
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

if (process.platform === 'win32' && process.env.RDC_AB_TEST_CASE !== 'handoff-only') {
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
  protectBenchmarkRootForTest(hostRoot);
  const launcher = path.join(hostSandbox, 'start-remote.cmd');
  const originalLauncher = '@echo off\r\necho ORIGINAL\r\n';
  await fs.writeFile(launcher, originalLauncher);
  const installer = path.join(benchmarkScriptsDir, 'Install-RdcAbLauncher.ps1');
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

  const poisonedLauncher = path.join(hostSandbox, 'poisoned-start-remote.cmd');
  const poisonedOriginal = '@echo off\r\necho POISON-TARGET\r\n';
  const poisonedBackup = '@echo off\r\necho ATTACKER-BACKUP\r\n';
  await fs.writeFile(poisonedLauncher, poisonedOriginal);
  await fs.writeFile(`${poisonedLauncher}.rdc-ab-original`, poisonedBackup);
  const poisonedInstall = spawnSync('powershell.exe', [
    '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', installer,
    '-BenchmarkRoot', hostRoot, '-LauncherPath', poisonedLauncher,
  ], { encoding: 'utf8' });
  assert.notEqual(poisonedInstall.status, 0, 'install must reject an unrecorded pre-existing launcher backup');
  assert.equal(await fs.readFile(poisonedLauncher, 'utf8'), poisonedOriginal);
  assert.equal(await fs.readFile(`${poisonedLauncher}.rdc-ab-original`, 'utf8'), poisonedBackup);
  await fs.rm(poisonedLauncher, { force: true });
  await fs.rm(`${poisonedLauncher}.rdc-ab-original`, { force: true });
  console.log('PASS RDC A/B install rejects attacker-supplied original backup');

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

  const installedSupervisorPath = path.join(hostRoot, 'host', 'Run-RdcAbSupervisor.ps1');
  const trustedInstalledSupervisor = await fs.readFile(installedSupervisorPath);
  const aclExecutionSentinel = path.join(hostSandbox, 'unsafe-host-script-executed.txt');
  const maliciousInstalledSupervisor = [
    '$ErrorActionPreference = "Stop"',
    '[IO.File]::WriteAllText($env:RDC_AB_ACL_SENTINEL, "executed")',
    `Write-Output '{"variant":"prototype"}'`,
    'exit 0',
  ].join('\r\n');
  await fs.writeFile(installedSupervisorPath, maliciousInstalledSupervisor);
  grantAuthenticatedUsersModify(installedSupervisorPath);
  const activationPreflight = path.join(benchmarkScriptsDir, 'Activate-RdcAbLauncher.ps1');
  const unsafeHostActivation = spawnSync('powershell.exe', [
    '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', activationPreflight,
    '-BenchmarkRoot', hostRoot, '-LauncherPath', launcher,
  ], { encoding: 'utf8', env: { ...process.env, RDC_AB_ACL_SENTINEL: aclExecutionSentinel } });
  assert.notEqual(unsafeHostActivation.status, 0);
  await assert.rejects(() => fs.access(aclExecutionSentinel), /ENOENT|no such file/i,
    'activation must reject an unsafe installed-host ACL before executing that script');
  const unsafeHostRestore = spawnSync('powershell.exe', [
    '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', path.join(benchmarkScriptsDir, 'Restore-RdcAbLauncher.ps1'),
    '-BenchmarkRoot', hostRoot, '-LauncherPath', launcher,
  ], { encoding: 'utf8', env: { ...process.env, RDC_AB_ACL_SENTINEL: aclExecutionSentinel } });
  assert.notEqual(unsafeHostRestore.status, 0);
  await assert.rejects(() => fs.access(aclExecutionSentinel), /ENOENT|no such file/i,
    'restore must reject an unsafe installed-host ACL before executing that script');
  await fs.writeFile(installedSupervisorPath, trustedInstalledSupervisor);
  protectBenchmarkRootForTest(hostRoot);
  console.log('PASS RDC A/B activation/restore preflight installed-host ACL before execution');

  const installRaceControl = path.join(hostSandbox, 'install-host-race-control');
  await fs.mkdir(installRaceControl);
  await fs.writeFile(path.join(installRaceControl, 'hold-activation'), '');
  const installRaceEnv = { ...process.env, RDC_AB_ENABLE_TEST_CONTROL: '1', RDC_AB_TEST_CONTROL_DIRECTORY: installRaceControl };
  const heldPreflightActivation = spawnCaptured('powershell.exe', [
    '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', activationPreflight,
    '-BenchmarkRoot', hostRoot, '-LauncherPath', launcher,
  ], { env: installRaceEnv, stdio: ['ignore', 'pipe', 'pipe'] });
  await waitForDirectoryCondition(installRaceControl,
    async () => fs.access(path.join(installRaceControl, 'activation-ready')).then(() => true, () => false)
      || heldPreflightActivation.child.exitCode !== null,
    [heldPreflightActivation], 'activation host-script race hold');
  assert.equal(heldPreflightActivation.child.exitCode, null, 'activation exited before host-script race hold');
  const alternateScripts = path.join(hostSandbox, 'alternate-installer');
  await fs.mkdir(alternateScripts);
  await fs.copyFile(installer, path.join(alternateScripts, 'Install-RdcAbLauncher.ps1'));
  await fs.copyFile(path.join(benchmarkScriptsDir, 'RdcAbAcl.ps1'), path.join(alternateScripts, 'RdcAbAcl.ps1'));
  const alternateSupervisor = Buffer.concat([trustedInstalledSupervisor, Buffer.from('\r\n# alternate-version-b\r\n')]);
  await fs.writeFile(path.join(alternateScripts, 'Run-RdcAbSupervisor.ps1'), alternateSupervisor);
  const racedHostInstall = spawnSync('powershell.exe', [
    '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', path.join(alternateScripts, 'Install-RdcAbLauncher.ps1'),
    '-BenchmarkRoot', hostRoot, '-LauncherPath', launcher,
  ], { encoding: 'utf8', env: installRaceEnv });
  assert.notEqual(racedHostInstall.status, 0);
  assert.deepEqual(await fs.readFile(installedSupervisorPath), trustedInstalledSupervisor,
    'a losing install must not replace host scripts before acquiring the launcher mutation mutex');
  await fs.writeFile(path.join(installRaceControl, 'activation-release'), '');
  await heldPreflightActivation.completed;
  await fs.rm(installRaceControl, { recursive: true, force: true });
  await fs.rm(alternateScripts, { recursive: true, force: true });
  console.log('PASS RDC A/B host-script replacement is inside launcher mutation mutex');

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
    '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', path.join(benchmarkScriptsDir, 'Restore-RdcAbLauncher.ps1'),
    '-BenchmarkRoot', hostRoot, '-LauncherPath', launcher,
  ], { encoding: 'utf8', env: installMutationEnvironment });
  assert.notEqual(racedInstallRestore.status, 0);
  assert.match(`${racedInstallRestore.stdout}\n${racedInstallRestore.stderr}`, /launcher mutation.+active/i);
  await fs.writeFile(path.join(installMutationControl, 'install-release'), '');
  const heldInstallResult = await heldInstall.completed;
  assert.equal(heldInstallResult.status, 0, `${heldInstallResult.stdout}\n${heldInstallResult.stderr}`);
  assert.equal(await fs.readFile(`${launcher}.rdc-ab-original`, 'utf8'), originalLauncher);
  console.log('PASS RDC A/B install mutation serialization and backup preservation');

  const supervisor = path.join(benchmarkScriptsDir, 'Run-RdcAbSupervisor.ps1');
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

  // This deliberately names a new seam: it must be reached after the last
  // runtime validation and immediately before node receives dist/index.js.
  // The current supervisor has no sealed selection at that point, so this is
  // permanent RED until it exposes the barrier and holds the selected bytes.
  const sealRoot = path.join(hostSandbox, 'post-validation-seal-benchmark');
  const sealRepo = path.join(sealRoot, 'clean', 'repo');
  const sealControl = path.join(hostSandbox, 'post-validation-seal-control');
  const originalMarkerPath = path.join(sealControl, 'original-marker');
  const originalMarker = 'sealed-original-marker';
  const overwriteMarker = 'overwrite-marker';
  const replacementMarker = 'replacement-marker';
  await fs.mkdir(sealControl);
  const sealEntrypointSource = `require('node:fs').writeFileSync(process.env.RDC_AB_TEST_MARKER, ${JSON.stringify(originalMarker)});\n`;
  const sealRuntime = await makeRuntimeRepo(sealRepo, sealEntrypointSource);
  await fs.writeFile(path.join(sealRoot, 'manifest.json'), JSON.stringify({
    schemaVersion: 1,
    benchmarkRoot: sealRoot,
    variants: {
      clean: {
        repoPath: sealRepo,
        expectedSha: sealRuntime.sha,
        buildDigest: sha256(sealEntrypointSource),
        runtimeDigest: sealRuntime.runtimeDigest,
      },
      prototype: {
        repoPath: sealRepo,
        expectedSha: sealRuntime.sha,
        buildDigest: sha256(sealEntrypointSource),
        runtimeDigest: sealRuntime.runtimeDigest,
      },
    },
  }));
  await fs.writeFile(path.join(sealRoot, 'active-variant.txt'), 'clean\n');
  protectBenchmarkRootForTest(sealRoot);
  const sealEntrypoint = path.join(sealRepo, 'dist', 'index.js');
  const replacementEntrypoint = path.join(sealControl, 'index.replacement.js');
  await fs.writeFile(replacementEntrypoint, `throw new Error(${JSON.stringify(replacementMarker)});\n`);
  const sealSupervisor = spawnCaptured('powershell.exe', [
    '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', supervisor,
    '-BenchmarkRoot', sealRoot, '-TestControlDirectory', sealControl,
  ], {
    env: {
      ...process.env,
      RDC_AB_ENABLE_TEST_CONTROL: '1',
      RDC_AB_TEST_MARKER: originalMarkerPath,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  try {
    // Release the older launch-decision test barrier: the new barrier must be
    // later, after the inner (final) Get-ValidatedSelection call.
    await fs.writeFile(path.join(sealControl, 'release'), '');
    await fs.writeFile(path.join(sealControl, 'hold-post-validation-seal'), '');
    try {
      await waitForDirectoryCondition(
        sealControl,
        async () => fs.access(path.join(sealControl, 'post-validation-seal-ready')).then(() => true, () => false)
          || sealSupervisor.child.exitCode !== null,
        [sealSupervisor],
        'supervisor post-validation sealed-selection barrier',
      );
    } catch (error) {
      const snapshot = await sealSupervisor.completed.catch(() => null);
      throw new Error(`${error.message}\nSUPERVISOR_STDOUT:\n${snapshot?.stdout ?? ''}\nSUPERVISOR_STDERR:\n${snapshot?.stderr ?? ''}`);
    }
    assert.equal(sealSupervisor.child.exitCode, null,
      'supervisor exited before the post-validation sealed-selection barrier');

    // Run the attacker outside this harness process. The two attempts must be
    // made after final validation, not merely after the earlier test hook.
    const injectedRuntimePath = path.join(sealRepo, 'dist', 'injected-after-validation.js');
    const mutationAttempt = spawnSync(process.execPath, ['-e', [
      "const fs = require('node:fs/promises');",
      'const [entrypoint, replacement, injected, overwrite] = process.argv.slice(1);',
      'const result = {};',
      '(async () => { for (const [name, action] of Object.entries({',
      '  overwrite: () => fs.writeFile(entrypoint, overwrite),',
      '  replacement: () => fs.rename(replacement, entrypoint),',
      '  create: () => fs.writeFile(injected, "injected-runtime"),',
      '})) {',
      '  try { await action(); result[name] = { succeeded: true }; }',
      '  catch (error) { result[name] = { succeeded: false, code: error.code }; }',
      '}',
      'process.stdout.write(JSON.stringify(result)); })().catch((error) => {',
      '  console.error(error.stack); process.exitCode = 1;',
      '});',
    ].join('\n'), sealEntrypoint, replacementEntrypoint, injectedRuntimePath,
    `throw new Error(${JSON.stringify(overwriteMarker)});\n`], {
      encoding: 'utf8', windowsHide: true,
    });
    assert.equal(mutationAttempt.status, 0, mutationAttempt.stderr);
    const mutationResult = JSON.parse(mutationAttempt.stdout);
    assert.equal(mutationResult.overwrite.succeeded, false,
      `a sealed selected entrypoint must reject a separate-process overwrite: ${mutationAttempt.stdout}`);
    assert.equal(mutationResult.replacement.succeeded, false,
      `a sealed selected entrypoint must reject separate-process atomic replacement: ${mutationAttempt.stdout}`);
    assert.equal(mutationResult.create.succeeded, false,
      `a sealed runtime tree must reject a new file after final validation: ${mutationAttempt.stdout}`);
    await assert.rejects(() => fs.access(injectedRuntimePath), /ENOENT|no such file/i);
    assert.deepEqual(await fs.readFile(sealEntrypoint), Buffer.from(sealEntrypointSource));

    await fs.writeFile(path.join(sealControl, 'post-validation-seal-release'), '');
    await waitForDirectoryCondition(
      sealControl,
      async () => fs.readFile(originalMarkerPath, 'utf8').then((value) => value === originalMarker, () => false)
        || sealSupervisor.child.exitCode !== null,
      [sealSupervisor],
      'node to execute the sealed original entrypoint bytes',
    );
    assert.equal(await fs.readFile(originalMarkerPath, 'utf8'), originalMarker);
    // Prevent the long-lived supervisor from immediately starting a second sealed
    // child. Its `exit` event is written only after runtime handles/namespace seal
    // and journal cleanup have completed.
    await fs.writeFile(path.join(sealControl, 'known-remote'), '');
    const sealLog = path.join(sealRoot, 'logs', 'supervisor.jsonl');
    await waitForDirectoryCondition(
      path.dirname(sealLog),
      async () => fs.readFile(sealLog, 'utf8').then((value) => value.includes('"event":"exit"'), () => false),
      [sealSupervisor],
      'supervisor to clean the runtime seal after the child exits',
    );
  } finally {
    await fs.writeFile(path.join(sealControl, 'release'), '').catch(() => {});
    await fs.writeFile(path.join(sealControl, 'post-validation-seal-release'), '').catch(() => {});
    if (sealSupervisor.child.exitCode === null) sealSupervisor.child.kill();
    await sealSupervisor.completed.catch(() => {});
    await fs.rm(sealRoot, { recursive: true, force: true }).catch(() => {});
    await fs.rm(sealControl, { recursive: true, force: true }).catch(() => {});
  }
  console.log('PASS RDC A/B supervisor seals the final validation-to-node selection');

  // A persistence error after Start must retain the seal until the owned child
  // exits. This uses an inert temporary fixture, never the installed Remote.
  const journalRoot = path.join(hostSandbox, 'journal-failure-benchmark');
  const journalRepo = path.join(journalRoot, 'clean', 'repo');
  const journalControl = path.join(hostSandbox, 'journal-failure-control');
  await fs.mkdir(journalControl);
  const childReady = path.join(journalControl, 'child-ready');
  const childRelease = path.join(journalControl, 'child-release');
  const childSource = [
    "const fs = require('node:fs');",
    `fs.writeFileSync(${JSON.stringify(childReady)}, String(process.pid));`,
    `setInterval(() => { if (fs.existsSync(${JSON.stringify(childRelease)})) process.exit(0); }, 25);`,
  ].join('\n');
  const journalRuntime = await makeRuntimeRepo(journalRepo, childSource);
  const journalVariant = { repoPath: journalRepo, expectedSha: journalRuntime.sha, runtimeDigest: journalRuntime.runtimeDigest };
  await fs.writeFile(path.join(journalRoot, 'manifest.json'), JSON.stringify({
    schemaVersion: 1, benchmarkRoot: journalRoot, variants: { clean: journalVariant, prototype: journalVariant },
  }));
  await fs.writeFile(path.join(journalRoot, 'active-variant.txt'), 'clean\n');
  protectBenchmarkRootForTest(journalRoot);
  for (const marker of ['release', 'hold-post-validation-seal', 'post-validation-seal-release', 'fail-child-journal-publication']) {
    await fs.writeFile(path.join(journalControl, marker), '');
  }
  const journalSupervisor = spawnCaptured('powershell.exe', [
    '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', supervisor,
    '-BenchmarkRoot', journalRoot, '-TestControlDirectory', journalControl,
  ], { env: { ...process.env, RDC_AB_ENABLE_TEST_CONTROL: '1' }, stdio: ['ignore', 'pipe', 'pipe'] });
  try {
    await waitForDirectoryCondition(journalControl,
      () => fs.access(childReady).then(() => true, () => false), [journalSupervisor], 'inert journal fixture child');
    const journalPath = path.join(journalRoot, '.rdc-ab-runtime-namespace-seal.json');
    assert.equal(JSON.parse(await fs.readFile(journalPath, 'utf8')).ChildPid, 0,
      'failed second publication must preserve the complete prelaunch record');
    assert.equal(journalSupervisor.child.exitCode, null, 'supervisor must retain ownership until child exit');
    await assert.rejects(async () => {
      const handle = await fs.open(path.join(journalRepo, 'dist', 'index.js'), 'r+');
      await handle.close();
    }, /EPERM|EACCES|EBUSY|permission|busy/i, 'live fixture runtime must remain sealed');
    await fs.writeFile(childRelease, '');
    const failure = await journalSupervisor.completed;
    assert.notEqual(failure.status, 0);
    assert.match(failure.stderr, /Test-controlled child journal publication failure/);
    await assert.rejects(() => fs.access(journalPath), /ENOENT|no such file/i);
    const reopened = await fs.open(path.join(journalRepo, 'dist', 'index.js'), 'r+');
    await reopened.close();
  } finally {
    await fs.writeFile(childRelease, '').catch(() => {});
    await journalSupervisor.completed;
    await fs.rm(journalRoot, { recursive: true, force: true }).catch(() => {});
    await fs.rm(journalControl, { recursive: true, force: true }).catch(() => {});
  }
  await assert.rejects(() => fs.access(journalRoot), /ENOENT|no such file/i,
    'journal fixture cleanup must not leave a sealed runtime behind');
  console.log('PASS RDC A/B journal publication failure retains protection until child exit');
  if (process.env.RDC_AB_TEST_CASE === 'supervisor-runtime-toctou') process.exit(0);

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

  const restore = path.join(benchmarkScriptsDir, 'Restore-RdcAbLauncher.ps1');
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
  // Supervisor test-control uses this marker independently of activation's
  // exact remote-process inventory. It remains until the old child exits.
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
  protectBenchmarkRootForTest(handoffRoot);

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
    "const authenticatedShutdown = `${signals}\\\\authenticated-shutdown-${instance}`;",
    "let closing = false;",
    "const close = () => {",
    "  if (closing) return;",
    "  closing = true;",
    "  if (instance === 1) fs.rmSync(`${signals}\\\\known-remote`, { force: true });",
    "  fs.writeFileSync(`${signals}\\\\old-exit-${instance}`, '');",
    "  process.exit(0);",
    "};",
    "process.on('SIGINT', () => fs.writeFileSync(`${signals}\\\\unexpected-sigint-${instance}`, ''));",
    "setInterval(() => { if (fs.existsSync(authenticatedShutdown)) close(); }, 25);",
  ].join('\r\n');
  await fs.writeFile(canonicalEntrypoint, oldChildSource);
  const handoffLauncher = path.join(handoffSandbox, 'start-remote.cmd');
  const originalWatcher = [
    '@echo off',
    'setlocal',
    `set "ROOT=${canonicalRepo}"`,
    `set "NODE=${process.execPath}"`,
    'set "ENTRY=%ROOT%\\dist\\index.js"',
    '',
    ':loop',
    '"%NODE%" "%ENTRY%" remote',
    'goto loop',
    '',
  ].join('\r\n');
  await fs.writeFile(handoffLauncher, originalWatcher);

  const oldWatcher = spawnCaptured(process.env.ComSpec ?? 'cmd.exe', [
    '/d', '/s', '/c', handoffLauncher,
  ], { detached: true, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  const decoyWatcher = spawnCaptured(process.env.ComSpec ?? 'cmd.exe', [
    '/d', '/q', '/k',
  ], { stdio: ['pipe', 'pipe', 'pipe'] });
  let activatedWrapperPid;
  let originalChildPid;
  let unrelatedRemotePid;
  try {
    await waitForDirectoryCondition(
      signals,
      async () => fs.readFile(oldInstancesPath, 'utf8').then((value) => {
        const pid = Number(value.trim());
        return Number.isInteger(pid) && pid > 0;
      }, () => false),
      [oldWatcher],
      'the fake canonical RDC child PID',
    );
    originalChildPid = Number((await fs.readFile(oldInstancesPath, 'utf8')).trim());
    assert.ok(Number.isInteger(originalChildPid) && originalChildPid > 0);

    const handoffInstaller = path.join(benchmarkScriptsDir, 'Install-RdcAbLauncher.ps1');
    const installHandoff = spawnSync('powershell.exe', [
      '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', handoffInstaller,
      '-BenchmarkRoot', handoffRoot, '-LauncherPath', handoffLauncher,
    ], { encoding: 'utf8' });
    assert.equal(installHandoff.status, 0, `${installHandoff.stdout}\n${installHandoff.stderr}`);
    assert.equal(await fs.readFile(`${handoffLauncher}.rdc-ab-original`, 'utf8'), originalWatcher);
    const watcherCreation = windowsProcessCreationIso(oldWatcher.child.pid);
    const remoteCreation = windowsProcessCreationIso(originalChildPid);
    const exactWatcherInventory = {
      Name: 'cmd.exe',
      ProcessId: oldWatcher.child.pid,
      CreationDate: watcherCreation,
      CommandLine: `cmd.exe /c ""${handoffLauncher}" "`,
    };
    const decoyWatcherInventory = {
      Name: 'cmd.exe',
      ProcessId: decoyWatcher.child.pid,
      CommandLine: 'cmd.exe /d /q /k',
    };
    const inventoryPath = path.join(signals, 'process-inventory.json');
    const remoteInventoryPath = path.join(signals, 'remote-process-inventory.json');
    const exactRemoteInventory = {
      Name: 'node.exe',
      ProcessId: originalChildPid,
      ParentProcessId: oldWatcher.child.pid,
      CreationDate: remoteCreation,
      CommandLine: `"${process.execPath}" "${canonicalEntrypoint}" remote`,
    };
    await fs.writeFile(remoteInventoryPath, JSON.stringify([exactRemoteInventory]));
    await fs.writeFile(inventoryPath, JSON.stringify([
      exactWatcherInventory,
      { ...exactWatcherInventory },
      decoyWatcherInventory,
    ]));

    const activation = path.join(benchmarkScriptsDir, 'Activate-RdcAbLauncher.ps1');
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
    // exact watcher invocation. These cases must fail before replacement launch.
    // A dedicated temp-only test hook below proves the observed production shape
    // reaches the replacement-launch boundary without trusting ComSpec.
    const prelaunchActivationOptions = activationOptions;
    for (const unsafeCommandLine of [
      `cmd.exe /d /q /k ""${handoffLauncher}""`,
      `cmd.exe /d /c ""${handoffLauncher}""`,
      `cmd.exe /q /c ""${handoffLauncher}""`,
      `cmd.exe /s /c ""${handoffLauncher}""`,
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

    await fs.writeFile(inventoryPath, JSON.stringify([{
      ...exactWatcherInventory,
      CommandLine: `cmd.exe /c ""${handoffLauncher}" "`,
    }]));
    await fs.writeFile(path.join(signals, 'fail-replacement-launch'), '');
    const productionShapeActivation = spawnSync('powershell.exe', activationArgs, prelaunchActivationOptions);
    await fs.rm(path.join(signals, 'fail-replacement-launch'), { force: true });
    assert.notEqual(productionShapeActivation.status, 0, 'production shape unexpectedly succeeded: ' + productionShapeActivation.stdout + '\n' + productionShapeActivation.stderr);
    assert.match(
      `${productionShapeActivation.stdout}\n${productionShapeActivation.stderr}`,
      /test-controlled replacement launcher failure/i,
      'observed production /c watcher shape must reach replacement launch rather than fail watcher matching',
    );
    assert.doesNotThrow(() => process.kill(oldWatcher.child.pid, 0));
    console.log('PASS RDC A/B activation accepts observed production /c watcher shape');
    const externalHostScript = path.join(handoffSandbox, 'external-rdc-host.ps1');
    await fs.writeFile(externalHostScript, `$bundle = '${canonicalEntrypoint.replaceAll("'", "''")}'\nStart-Process -FilePath '${process.execPath.replaceAll("'", "''")}' -ArgumentList @($bundle,'remote','--persist-session')\n`);
    const hostOrchestratorInventory = path.join(signals, 'host-orchestrator-inventory.json');
    await fs.writeFile(hostOrchestratorInventory, JSON.stringify([{
      TaskName: 'Codebase44 Remote Desktop Commander SYSTEM', Enabled: true, State: 'Ready',
      Actions: [{ Execute: 'powershell.exe', Arguments: `-NoProfile -File "${externalHostScript}"` }],
    }]));
    await fs.writeFile(path.join(signals, 'fail-replacement-launch'), '');
    const competingOrchestratorActivation = spawnSync('powershell.exe', activationArgs, activationOptions);
    await fs.rm(path.join(signals, 'fail-replacement-launch'), { force: true });
    assert.notEqual(competingOrchestratorActivation.status, 0);
    assert.match(`${competingOrchestratorActivation.stdout}\n${competingOrchestratorActivation.stderr}`, /competing.+host.+orchestrator|enabled.+orchestrator/i);
    assert.doesNotThrow(() => process.kill(oldWatcher.child.pid, 0));
    await fs.rm(hostOrchestratorInventory, { force: true });
    console.log('PASS RDC A/B activation rejects enabled competing host orchestrator');

    // Remote identity is fail-closed independently of watcher matching. Neither
    // an unrelated remote, a correct-looking command with the wrong parent, nor
    // a watcher child running the wrong entrypoint may authorize handoff.
    const unrelatedRemote = spawnCaptured(process.execPath, [
      '-e', 'Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 60000)', 'remote',
    ], { stdio: ['ignore', 'pipe', 'pipe'] });
    unrelatedRemotePid = unrelatedRemote.child.pid;
    const wrongEntrypoint = path.join(handoffSandbox, 'other', 'dist', 'index.js');
    for (const invalidRemoteInventory of [
      [{
        Name: 'node.exe', ProcessId: unrelatedRemotePid, ParentProcessId: 0,
        CommandLine: `"${process.execPath}" -e "unrelated remote" remote`,
      }],
      [{ ...exactRemoteInventory, ParentProcessId: 0 }],
      [{ ...exactRemoteInventory, CreationDate: '2000-01-01T00:00:00.000Z' }],
      [{
        ...exactRemoteInventory,
        CommandLine: `"${process.execPath}" "${wrongEntrypoint}" remote`,
      }],
    ]) {
      await fs.writeFile(remoteInventoryPath, JSON.stringify(invalidRemoteInventory));
      await fs.writeFile(inventoryPath, JSON.stringify([exactWatcherInventory]));
      const invalidRemoteActivation = spawnSync('powershell.exe', activationArgs, prelaunchActivationOptions);
      assert.notEqual(invalidRemoteActivation.status, 0);
      assert.match(
        `${invalidRemoteActivation.stdout}\n${invalidRemoteActivation.stderr}`,
        /exact.+live.+RDC.+child|remote.+(canonical|watcher|entrypoint|parent)/i,
      );
      assert.doesNotThrow(() => process.kill(oldWatcher.child.pid, 0));
    }
    await fs.writeFile(remoteInventoryPath, JSON.stringify([exactRemoteInventory]));
    console.log('PASS RDC A/B activation requires the exact old-watcher remote child');

    // A recycled PID must not let activation reacquire a different cmd.exe than
    // the watcher selected from the process inventory. Creation time binds them.
    await fs.writeFile(inventoryPath, JSON.stringify([{
      ...exactWatcherInventory,
      CreationDate: '2000-01-01T00:00:00.000Z',
    }]));
    const recycledWatcherActivation = spawnSync('powershell.exe', activationArgs, prelaunchActivationOptions);
    assert.notEqual(recycledWatcherActivation.status, 0);
    assert.match(
      `${recycledWatcherActivation.stdout}\n${recycledWatcherActivation.stderr}`,
      /watcher.+(creation|changed|identity|reused)/i,
    );
    assert.doesNotThrow(() => process.kill(oldWatcher.child.pid, 0));
    await fs.writeFile(inventoryPath, JSON.stringify([exactWatcherInventory]));
    console.log('PASS RDC A/B activation rejects recycled watcher PID identity');

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
    await fs.rm(path.join(signals, 'activation-ready'));
    const restoreDelegator = spawnSync('powershell.exe', [
      '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', handoffInstaller,
      '-BenchmarkRoot', handoffRoot, '-LauncherPath', handoffLauncher,
    ], { encoding: 'utf8' });
    assert.equal(restoreDelegator.status, 0, `${restoreDelegator.stdout}\n${restoreDelegator.stderr}`);
    console.log('PASS RDC A/B activation closes validation-to-launch TOCTOU');
    await fs.writeFile(inventoryPath, JSON.stringify([
      exactWatcherInventory,
      { ...exactWatcherInventory },
      decoyWatcherInventory,
    ]));
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

    await fs.writeFile(path.join(signals, 'fail-replacement-launch'), '');
    const failedStartActivation = spawnSync('powershell.exe', activationArgs, activationOptions);
    await fs.rm(path.join(signals, 'fail-replacement-launch'), { force: true });
    assert.notEqual(failedStartActivation.status, 0);
    assert.match(`${failedStartActivation.stdout}\n${failedStartActivation.stderr}`, /test-controlled replacement launcher failure/i);
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

    const handoffRestore = path.join(benchmarkScriptsDir, 'Restore-RdcAbLauncher.ps1');
    const liveShapeLocalMcpPid = 2147480000;
    const liveShapeLocalMcpInventory = {
      Name: 'node.exe',
      ProcessId: liveShapeLocalMcpPid,
      ParentProcessId: originalChildPid,
      CreationDate: new Date(Date.parse(remoteCreation) + 1000).toISOString(),
      CommandLine: `"${process.execPath}" ${canonicalEntrypoint}`,
    };
    // Match the observed live Windows StdioClientTransport shape: Node is quoted
    // because its path contains spaces, while dist/index.js is not quoted.
    await fs.writeFile(remoteInventoryPath, JSON.stringify([
      exactRemoteInventory,
      { ...liveShapeLocalMcpInventory, CommandLine: `"${process.execPath}" ${canonicalEntrypoint} --unexpected` },
    ]));
    const trailingLocalArgActivation = spawnSync('powershell.exe', activationArgs, activationOptions);
    assert.notEqual(trailingLocalArgActivation.status, 0);
    assert.match(
      `${trailingLocalArgActivation.stdout}\n${trailingLocalArgActivation.stderr}`,
      /unexpected direct Node child|local MCP child/i,
    );
    assert.doesNotThrow(() => process.kill(oldWatcher.child.pid, 0));
    await fs.writeFile(remoteInventoryPath, JSON.stringify([
      exactRemoteInventory,
      liveShapeLocalMcpInventory,
    ]));
    console.log('PASS RDC A/B local MCP parser rejects trailing arguments');
    const launchMarkersBeforeFinalHandoff = new Set(
      (await fs.readdir(signals)).filter((name) => name.startsWith('launch-')),
    );
    await fs.rm(path.join(signals, 'activation-ready'), { force: true });
    await fs.rm(path.join(signals, 'activation-release'), { force: true });
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
    try {
      await waitForDirectoryCondition(
        signals,
        async () => fs.access(path.join(signals, 'authenticated-shutdown-ready')).then(() => true, () => false)
          || heldActivation.child.exitCode !== null,
        [heldActivation],
        'activation to retire the watcher and await authenticated Remote shutdown',
      );
    } catch (error) {
      const earlyActivation = await heldActivation.completed;
      throw new Error(`${error.message}\nEARLY_ACTIVATION_STATUS=${earlyActivation.status}\n${earlyActivation.stdout}\n${earlyActivation.stderr}`);
    }
    if (heldActivation.child.exitCode !== null) {
      const earlyActivation = await heldActivation.completed;
      assert.fail(`activation exited before authenticated shutdown handoff\n${earlyActivation.stdout}\n${earlyActivation.stderr}`);
    }
    console.log('PASS RDC A/B activation and restore are mutation-serialized');
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
      'the exact old watcher to exit before authenticated shutdown',
    );
    assert.doesNotThrow(() => process.kill(originalChildPid, 0),
      'old Remote must remain alive until authenticated shutdown is requested');
    const signalsBeforeAuthenticatedShutdown = await fs.readdir(signals);
    assert.ok(!signalsBeforeAuthenticatedShutdown.includes('unexpected-sigint-1'),
      'activation must not signal the old Remote through the Windows console');
    assert.deepEqual(
      signalsBeforeAuthenticatedShutdown.filter(
        (name) => name.startsWith('launch-') && !launchMarkersBeforeFinalHandoff.has(name),
      ),
      [],
      'replacement launch authority must wait for authenticated old-Remote shutdown',
    );

    await fs.writeFile(path.join(signals, 'authenticated-shutdown-1'), '');
    const activateRun = await heldActivation.completed;
    assert.equal(activateRun.status, 0, `${activateRun.stdout}\n${activateRun.stderr}`);
    const activationLines = activateRun.stdout.trim().split(/\r?\n/).filter(Boolean);
    const activationResult = JSON.parse(activationLines.at(-1));
    activatedWrapperPid = activationResult.startedWrapperPid;
    assert.equal(activationResult.stoppedWatcherPid, oldWatcher.child.pid);
    assert.equal(activationResult.variant, 'prototype');
    await waitForDirectoryCondition(
      signals,
      async () => {
        const names = await fs.readdir(signals);
        return names.includes('old-exit-1') && names.some(
          (name) => name.startsWith('launch-') && !launchMarkersBeforeFinalHandoff.has(name),
        );
      },
      [],
      'authenticated old-Remote exit and replacement supervisor launch authority',
    );
    const signalsAfterAuthenticatedShutdown = await fs.readdir(signals);
    assert.ok(!signalsAfterAuthenticatedShutdown.includes('unexpected-sigint-1'));
    assert.throws(() => process.kill(originalChildPid, 0), /ESRCH|no such process/i,
      'activation must not return with the exact old Remote child still alive');
    assert.equal((await fs.readFile(oldInstancesPath, 'utf8')).trim().split(/\r?\n/).length, 1);
    console.log('PASS RDC A/B authenticated graceful watcher activation handoff');
  } finally {
    await fs.writeFile(path.join(signals, 'authenticated-shutdown-1'), '').catch(() => {});
    await fs.writeFile(path.join(signals, 'authenticated-shutdown-2'), '').catch(() => {});
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
assert.equal(initialized.variants.clean.runtimeDigest, await runtimeDigest(extraClean));
assert.equal(initialized.variants.prototype.runtimeDigest, await runtimeDigest(extraPrototype));
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
