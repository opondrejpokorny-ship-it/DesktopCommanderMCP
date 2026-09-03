/**
 * RED -> GREEN tests for the native active work registry.
 */
// Assertions unchanged; this line triggers exact-head GREEN CI after integrating the current authoritative prototype baseline.
import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import {
  checkActiveWork,
  listActiveWork,
  registerActiveWork,
  removeActiveWork,
  resolveActiveWorkRegistryPath,
  updateActiveWork,
} from '../dist/workflow/active-work-registry.js';
import { applyCoreSafetyGate } from '../dist/runtime/core-safety.js';

const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'dc-active-work-registry-'));
const repoRoot = path.join(tempDir, 'repo');
const stateRoot = path.join(tempDir, 'state');
const worktreeB = path.join(tempDir, 'repo-b');
const moduleUrl = new URL('../dist/workflow/active-work-registry.js', import.meta.url).href;

function git(cwd, ...args) {
  return execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8' }).trim();
}

function spawnRegistryRegistration(projectRoot, index) {
  const script = `
    const mod = await import(process.argv[1]);
    const result = await mod.registerActiveWork({
      projectRoot: process.argv[2],
      title: 'Parallel task ' + process.argv[3],
      scope: 'Independent concurrent registry mutation',
      affectedAreas: ['docs/parallel-' + process.argv[3] + '.md'],
      nextAction: 'Verify persistence'
    });
    if (!result.registered) {
      console.error(JSON.stringify(result));
      process.exit(2);
    }
  `;
  return new Promise((resolve, reject) => {
    const child = spawn(
      process.execPath,
      ['--input-type=module', '-e', script, moduleUrl, projectRoot, String(index)],
      {
        env: {
          ...process.env,
          DESKTOP_COMMANDER_WORKFLOW_STATE_DIR: stateRoot,
        },
        stdio: ['ignore', 'pipe', 'pipe'],
      },
    );
    let stderr = '';
    child.stderr.on('data', (chunk) => { stderr += chunk.toString(); });
    child.on('error', reject);
    child.on('exit', (code) => {
      if (code === 0) resolve();
      else reject(new Error('child registration failed: ' + code + '\n' + stderr));
    });
  });
}

try {
  process.env.DESKTOP_COMMANDER_WORKFLOW_STATE_DIR = stateRoot;
  await fs.mkdir(repoRoot, { recursive: true });
  execFileSync('git', ['init', repoRoot]);
  git(repoRoot, 'config', 'user.email', 'test@example.invalid');
  git(repoRoot, 'config', 'user.name', 'Active Work Registry Test');
  await fs.writeFile(path.join(repoRoot, 'README.md'), '# Registry\n');
  git(repoRoot, 'add', '.');
  git(repoRoot, 'commit', '-m', 'baseline');
  git(
    repoRoot,
    'remote',
    'add',
    'origin',
    'https://token-user:ghp_super_secret_value123@github.com/Example/RegistryRepo.git',
  );
  git(repoRoot, 'worktree', 'add', '-b', 'worker-b', worktreeB);

  const first = await registerActiveWork({
    projectRoot: repoRoot,
    title: 'Native Active Work Registry',
    scope:
      'Implement registry. ghp_super_secret_value123 password=hunter2 ' +
      'Bearer abc.def.ghi',
    affectedAreas: ['src/workflow/active-work-registry.ts'],
    riskAreas: ['workflow-control-plane', 'persistence'],
    target: 'prototype/free-pro-team',
    safeParallelWork: ['Read-only documentation analysis'],
    nextAction: 'Create focused RED tests',
    conflictRisk: 'Do not modify the existing project_workflow contract',
  });
  assert.equal(first.registered, true);
  assert.equal(first.guidance, 'safe_parallel');
  assert.ok(first.entry?.id);
  assert.equal(first.repository.display, 'github.com/example/registryrepo');

  const duplicate = await checkActiveWork({
    projectRoot: worktreeB,
    title: 'Native Active Work Registry',
    scope:
      'Implement registry. ghp_super_secret_value123 password=hunter2 ' +
      'Bearer abc.def.ghi',
    affectedAreas: ['src/workflow/active-work-registry.ts'],
    riskAreas: ['workflow-control-plane', 'persistence'],
  });
  assert.equal(duplicate.guidance, 'continue_existing');
  assert.equal(duplicate.conflicts[0]?.entry.id, first.entry.id);

  const overlap = await checkActiveWork({
    projectRoot: worktreeB,
    title: 'Change workflow persistence',
    scope: 'A different task touching the same control plane',
    affectedAreas: ['src/workflow'],
    riskAreas: ['persistence'],
  });
  assert.equal(overlap.guidance, 'wait_or_read_only');
  assert.ok(
    overlap.conflicts.some((item) =>
      item.reasons.includes('affected_area_overlap') ||
      item.reasons.includes('risk_area_overlap'),
    ),
  );

  const refusedConflict = await registerActiveWork({
    projectRoot: worktreeB,
    title: 'Conflicting workflow mutation',
    scope: 'Attempt a second mutation in the same workflow area',
    affectedAreas: ['src/workflow'],
    riskAreas: ['persistence'],
    nextAction: 'Must not be registered',
  });
  assert.equal(refusedConflict.registered, false);
  assert.equal(refusedConflict.guidance, 'wait_or_read_only');
  assert.equal(
    (await listActiveWork({ projectRoot: repoRoot })).entries.length,
    1,
    'conflicting register must not create another active entry',
  );

  const safe = await checkActiveWork({
    projectRoot: worktreeB,
    title: 'Independent docs update',
    scope: 'Edit an unrelated documentation file',
    affectedAreas: ['docs/independent.md'],
  });
  assert.equal(safe.guidance, 'safe_parallel');

  const docsEntry = await registerActiveWork({
    projectRoot: worktreeB,
    title: 'Independent docs update',
    scope: 'Edit an unrelated documentation file',
    affectedAreas: ['docs/independent.md'],
    nextAction: 'Write documentation',
  });
  assert.equal(docsEntry.registered, true);

  const updated = await updateActiveWork({
    projectRoot: worktreeB,
    entryId: docsEntry.entry.id,
    nextAction: 'Run documentation checks',
  });
  assert.equal(updated.entry.nextAction, 'Run documentation checks');

  const listedFromOtherWorktree = await listActiveWork({ projectRoot: worktreeB });
  assert.equal(listedFromOtherWorktree.entries.length, 2);
  assert.equal(
    listedFromOtherWorktree.repository.id,
    first.repository.id,
    'Different worktrees of one repository must share registry identity',
  );

  const registryPath = resolveActiveWorkRegistryPath();
  const gate = await applyCoreSafetyGate('write_file', {
    path: registryPath,
    content: 'tamper',
  });
  assert.equal(gate.allowed, false);
  assert.match(
    gate.result?.content?.[0]?.text ?? '',
    /project-workflow-control-plane/i,
  );

  const persisted = await fs.readFile(registryPath, 'utf8');
  for (const secret of [
    'ghp_super_secret_value123',
    'hunter2',
    'abc.def.ghi',
    'token-user',
  ]) {
    assert.ok(!persisted.includes(secret), 'persisted registry leaked: ' + secret);
  }
  assert.match(persisted, /\[REDACTED\]/);
  assert.ok(!persisted.includes('rawCommand'));
  assert.ok(!persisted.includes('fileContents'));

  await fs.writeFile(registryPath, '{"version":1,"entries":', 'utf8');
  await assert.rejects(
    () => listActiveWork({ projectRoot: worktreeB }),
    /Invalid active work registry|Refusing to continue/i,
    'corrupt registry must fail closed instead of resetting active work',
  );
  await fs.writeFile(registryPath, persisted, 'utf8');

  const restartScript = `
    const mod = await import(process.argv[1]);
    const result = await mod.listActiveWork({ projectRoot: process.argv[2] });
    process.stdout.write(JSON.stringify(result));
  `;
  const restartedRaw = execFileSync(
    process.execPath,
    ['--input-type=module', '-e', restartScript, moduleUrl, worktreeB],
    {
      encoding: 'utf8',
      env: {
        ...process.env,
        DESKTOP_COMMANDER_WORKFLOW_STATE_DIR: stateRoot,
      },
    },
  );
  const restarted = JSON.parse(restartedRaw);
  assert.equal(restarted.entries.length, 2, 'registry must survive process restart');

  const parallelRoots = [];
  for (let index = 0; index < 4; index += 1) {
    const worktree = path.join(tempDir, 'parallel-' + index);
    git(repoRoot, 'worktree', 'add', '-b', 'parallel-' + index, worktree);
    parallelRoots.push(worktree);
  }
  await Promise.all(
    parallelRoots.map((worktree, index) =>
      spawnRegistryRegistration(worktree, index),
    ),
  );

  const afterParallel = await listActiveWork({ projectRoot: repoRoot });
  for (let index = 0; index < 4; index += 1) {
    assert.ok(
      afterParallel.entries.some((entry) => entry.title === 'Parallel task ' + index),
      'cross-process mutation lost parallel task ' + index,
    );
  }

  const removed = await removeActiveWork({
    projectRoot: worktreeB,
    entryId: first.entry.id,
  });
  assert.equal(removed.removed, true);
  assert.ok(!removed.entries.some((entry) => entry.id === first.entry.id));

  console.log('✅ Active work registry tests passed');
} finally {
  delete process.env.DESKTOP_COMMANDER_WORKFLOW_STATE_DIR;
  await fs.rm(tempDir, { recursive: true, force: true });
}
