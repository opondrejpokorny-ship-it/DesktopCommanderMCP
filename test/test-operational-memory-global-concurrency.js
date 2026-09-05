import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  getProjectWorkflowStatus,
  recordOperationalLesson,
  startProjectWorkflow,
} from '../dist/workflow/project-workflow.js';
import { resolveOperationalMemoryGlobalIndexPath } from '../dist/workflow/operational-memory-global-index.js';

const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'dc-memory-m3b-concurrency-'));
const stateRoot = path.join(tempDir, 'state');
const projectA = path.join(tempDir, 'project-a');
const projectB = path.join(tempDir, 'project-b');
const projectC = path.join(tempDir, 'project-c');
const previousStateRoot = process.env.DESKTOP_COMMANDER_WORKFLOW_STATE_DIR;
process.env.DESKTOP_COMMANDER_WORKFLOW_STATE_DIR = stateRoot;

function git(root, ...args) {
  return execFileSync('git', ['-C', root, ...args], { encoding: 'utf8' }).trim();
}

async function initRepo(root, origin) {
  await fs.mkdir(path.join(root, '.desktop-commander'), { recursive: true });
  await fs.writeFile(path.join(root, '.desktop-commander', 'project-workflow.json'), JSON.stringify({
    version: 1,
    id: 'm3b-concurrency-' + path.basename(root),
    name: 'M3B concurrency ' + path.basename(root),
    stages: [{ id: 'inspect', label: 'Inspect', required: true }],
  }, null, 2));
  execFileSync('git', ['init', root], { stdio: 'ignore' });
  git(root, 'config', 'user.email', 'm3b-concurrency@example.invalid');
  git(root, 'config', 'user.name', 'M3B Concurrency Test');
  git(root, 'remote', 'add', 'origin', origin);
  await fs.writeFile(path.join(root, 'README.md'), '# m3b concurrency\n');
  git(root, 'add', '.');
  git(root, 'commit', '-m', 'baseline');
}

function runWriter(projectRoot, count) {
  const testDir = path.dirname(fileURLToPath(import.meta.url));
  const script = path.join(testDir, 'fixtures', 'operational-memory-writer.js');
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [script, projectRoot, stateRoot, String(count), 'tooling_availability_check'], {
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

try {
  await initRepo(projectA, 'https://github.com/example/m3b-concurrency-a.git');
  await initRepo(projectB, 'https://github.com/example/m3b-concurrency-b.git');
  await initRepo(projectC, 'https://github.com/example/m3b-concurrency-c.git');

  await startProjectWorkflow({ projectRoot: projectA, goal: 'Seed project A' });
  await startProjectWorkflow({ projectRoot: projectB, goal: 'Seed project B' });
  assert.equal(await recordOperationalLesson({
    projectRoot: projectA,
    lessonCode: 'tooling_availability_check',
  }), true);
  assert.equal(await recordOperationalLesson({
    projectRoot: projectB,
    lessonCode: 'tooling_availability_check',
  }), true);

  const firstC = await startProjectWorkflow({ projectRoot: projectC, goal: 'Consume concurrent global memory' });
  const initial = firstC.operationalMemory.lessons.find(
    (item) => item.lessonCode === 'tooling_availability_check',
  );
  assert.equal(initial?.scope, 'global');
  assert.equal(initial?.relevanceReason, 'global_repeated');
  assert.equal(initial?.occurrences, 2);

  const staleGlobalLock = path.join(stateRoot, 'operational-memory.global.lock');
  await fs.mkdir(staleGlobalLock);
  const staleAt = new Date(Date.now() - 120_000);
  await fs.utimes(staleGlobalLock, staleAt, staleAt);

  await Promise.all([
    runWriter(projectA, 10),
    runWriter(projectB, 10),
  ]);

  const finalC = await getProjectWorkflowStatus({ projectRoot: projectC });
  const globalLesson = finalC.operationalMemory.lessons.find(
    (item) => item.lessonCode === 'tooling_availability_check',
  );
  assert.ok(globalLesson);
  assert.equal(globalLesson.scope, 'global');
  assert.equal(globalLesson.relevanceReason, 'global_repeated');
  assert.equal(globalLesson.occurrences, 22);
  assert.ok(finalC.operationalMemory.lessons.length <= 8);

  const globalPath = resolveOperationalMemoryGlobalIndexPath();
  assert.ok((await fs.stat(globalPath)).isFile());
  assert.equal(
    await fs.stat(path.join(stateRoot, 'operational-memory.global.lock')).then(() => true, () => false),
    false,
    'global writer lock must not leave residue',
  );
  console.log('✅ Operational Memory M3B concurrent global updates passed');
} finally {
  if (previousStateRoot === undefined) delete process.env.DESKTOP_COMMANDER_WORKFLOW_STATE_DIR;
  else process.env.DESKTOP_COMMANDER_WORKFLOW_STATE_DIR = previousStateRoot;
  await fs.rm(tempDir, { recursive: true, force: true });
}
