/** M1 RED/GREEN coverage for Operational Memory JSONL durability. */
import assert from 'node:assert';
import { execFileSync, spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';

import {
  recordOperationalLesson,
  resolveWorkflowMemoryPath,
  startProjectWorkflow,
} from '../dist/workflow/project-workflow.js';

async function withFixture(label, fn) {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), `dc-memory-m1-${label}-`));
  const projectRoot = path.join(tempDir, 'repo');
  const stateRoot = path.join(tempDir, 'state');
  const previousStateRoot = process.env.DESKTOP_COMMANDER_WORKFLOW_STATE_DIR;
  process.env.DESKTOP_COMMANDER_WORKFLOW_STATE_DIR = stateRoot;

  try {
    await fs.mkdir(path.join(projectRoot, '.desktop-commander'), { recursive: true });
    await fs.writeFile(
      path.join(projectRoot, '.desktop-commander', 'project-workflow.json'),
      JSON.stringify({
        version: 1,
        id: `memory-m1-${label}`,
        name: `Operational Memory M1 ${label}`,
        stages: [{ id: 'inspect', label: 'Inspect', required: true }],
      }, null, 2),
    );
    execFileSync('git', ['init', projectRoot]);
    execFileSync('git', ['-C', projectRoot, 'config', 'user.email', 'test@example.invalid']);
    execFileSync('git', ['-C', projectRoot, 'config', 'user.name', 'Memory M1 Test']);
    await fs.writeFile(path.join(projectRoot, 'README.md'), '# m1 test\n');
    execFileSync('git', ['-C', projectRoot, 'add', '.']);
    execFileSync('git', ['-C', projectRoot, 'commit', '-m', 'baseline']);
    await startProjectWorkflow({ projectRoot, goal: `M1 ${label}` });
    await fn({ projectRoot, stateRoot });
  } finally {
    if (previousStateRoot === undefined) {
      delete process.env.DESKTOP_COMMANDER_WORKFLOW_STATE_DIR;
    } else {
      process.env.DESKTOP_COMMANDER_WORKFLOW_STATE_DIR = previousStateRoot;
    }
    await fs.rm(tempDir, { recursive: true, force: true });
  }
}

async function validEvents(memoryPath) {
  const text = await fs.readFile(memoryPath, 'utf8');
  return text
    .split(/\r?\n/)
    .filter(Boolean)
    .map((line) => {
      try { return JSON.parse(line); } catch { return null; }
    })
    .filter(Boolean);
}

await withFixture('truncated-tail', async ({ projectRoot }) => {
  const memoryPath = resolveWorkflowMemoryPath(projectRoot);
  await fs.mkdir(path.dirname(memoryPath), { recursive: true });
  await fs.writeFile(memoryPath, '{"version":1,"id":"partial"', 'utf8');
  const recorded = await recordOperationalLesson({
    projectRoot,
    lessonCode: 'fetch_required_git_refs',
  });
  assert.strictEqual(recorded, true);

  const events = await validEvents(memoryPath);
  assert.ok(
    events.some((event) => event.lessonCode === 'fetch_required_git_refs'),
    'the first valid append after a truncated fragment must remain a readable JSONL record',
  );
  const raw = await fs.readFile(memoryPath, 'utf8');
  assert.ok(
    raw.includes('{"version":1,"id":"partial"\n'),
    'the damaged historical fragment must be preserved and separated, not rewritten',
  );
  console.log('PASS truncated final fragment does not swallow the next event');
});

await withFixture('active-lock', async ({ projectRoot }) => {
  const memoryPath = resolveWorkflowMemoryPath(projectRoot);
  const lockPath = memoryPath + '.lock';
  await fs.mkdir(path.dirname(lockPath), { recursive: true });
  await fs.mkdir(lockPath);

  let resolved = false;
  const pending = recordOperationalLesson({
    projectRoot,
    lessonCode: 'fetch_required_git_refs',
  }).then((value) => {
    resolved = true;
    return value;
  });

  await delay(120);
  assert.strictEqual(
    resolved,
    false,
    'a cooperative writer must not ignore an active cross-process journal lock',
  );
  await fs.rm(lockPath, { recursive: true, force: true });
  assert.strictEqual(await pending, true);
  assert.strictEqual(await fs.stat(memoryPath).then(() => true, () => false), true);
  console.log('PASS active journal lock is respected');
});

await withFixture('stale-lock', async ({ projectRoot }) => {
  const memoryPath = resolveWorkflowMemoryPath(projectRoot);
  const lockPath = memoryPath + '.lock';
  await fs.mkdir(path.dirname(lockPath), { recursive: true });
  await fs.mkdir(lockPath);
  const old = new Date(Date.now() - 120_000);
  await fs.utimes(lockPath, old, old);

  const recorded = await recordOperationalLesson({
    projectRoot,
    lessonCode: 'fetch_required_git_refs',
  });
  assert.strictEqual(recorded, true);
  assert.strictEqual(
    await fs.stat(lockPath).then(() => true, () => false),
    false,
    'a stale lock must be recovered and removed after append',
  );
  console.log('PASS stale journal lock is recovered');
});

await withFixture('stale-recovery-guard', async ({ projectRoot }) => {
  const memoryPath = resolveWorkflowMemoryPath(projectRoot);
  const lockPath = memoryPath + '.lock';
  const recoveryPath = lockPath + '.recovery';
  await fs.mkdir(path.dirname(lockPath), { recursive: true });
  await fs.mkdir(lockPath);
  const old = new Date(Date.now() - 120_000);
  await fs.utimes(lockPath, old, old);
  await fs.mkdir(recoveryPath);

  let resolved = false;
  const pending = recordOperationalLesson({
    projectRoot,
    lessonCode: 'fetch_required_git_refs',
  }).then((value) => {
    resolved = true;
    return value;
  });

  await delay(120);
  assert.strictEqual(resolved, false, 'a stale-lock recovery already owned by another process must be respected');
  assert.strictEqual(await fs.stat(lockPath).then(() => true, () => false), true, 'the stale lock must not be removed while another recovery owns the guard');
  await fs.rm(recoveryPath, { recursive: true, force: true });
  assert.strictEqual(await pending, true);
  console.log('PASS stale recovery guard serializes stale-lock reclamation');
});

function runWriter(projectRoot, stateRoot, count, lessonCode) {
  const testDir = path.dirname(fileURLToPath(import.meta.url));
  const script = path.join(testDir, 'fixtures', 'operational-memory-writer.js');
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [script, projectRoot, stateRoot, String(count), lessonCode], {
      cwd: process.cwd(),
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stderr = '';
    child.stderr.on('data', (chunk) => { stderr += chunk.toString(); });
    child.on('error', reject);
    child.on('exit', (code) => code === 0
      ? resolve()
      : reject(new Error('writer exited ' + code + ': ' + stderr)));
  });
}

await withFixture('two-process-writers', async ({ projectRoot, stateRoot }) => {
  const memoryPath = resolveWorkflowMemoryPath(projectRoot);
  await Promise.all([
    runWriter(projectRoot, stateRoot, 25, 'fetch_required_git_refs'),
    runWriter(projectRoot, stateRoot, 25, 'shell_quoting_unreliable'),
  ]);
  const rawLines = (await fs.readFile(memoryPath, 'utf8')).split(/\r?\n/).filter(Boolean);
  const parsed = rawLines.map((line) => JSON.parse(line));
  assert.strictEqual(parsed.length, 50);
  assert.strictEqual(parsed.filter((event) => event.lessonCode === 'fetch_required_git_refs').length, 25);
  assert.strictEqual(parsed.filter((event) => event.lessonCode === 'shell_quoting_unreliable').length, 25);
  assert.strictEqual(await fs.stat(memoryPath + '.lock').then(() => true, () => false), false);
  console.log('PASS two processes append complete JSONL records without residue');
});

console.log('✅ Operational Memory M1 storage hardening tests passed');
