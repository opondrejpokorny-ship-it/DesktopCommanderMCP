/** RED: M2 must not checkpoint past an unterminated JSONL record. */
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import {
  getProjectWorkflowStatus,
  recordOperationalToolFailure,
  resolveWorkflowMemoryPath,
  startProjectWorkflow,
} from '../dist/workflow/project-workflow.js';

const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'dc-memory-m2-tail-'));
const projectRoot = path.join(tempDir, 'repo');
const stateRoot = path.join(tempDir, 'state');
const previousStateRoot = process.env.DESKTOP_COMMANDER_WORKFLOW_STATE_DIR;
process.env.DESKTOP_COMMANDER_WORKFLOW_STATE_DIR = stateRoot;

function git(...args) {
  return execFileSync('git', ['-C', projectRoot, ...args], { encoding: 'utf8' }).trim();
}
try {
  await fs.mkdir(path.join(projectRoot, '.desktop-commander'), { recursive: true });
  await fs.writeFile(path.join(projectRoot, '.desktop-commander', 'project-workflow.json'), JSON.stringify({
    version: 1,
    id: 'memory-m2-tail',
    name: 'Operational Memory M2 tail',
    stages: [{ id: 'inspect', label: 'Inspect', required: true }],
  }, null, 2));
  execFileSync('git', ['init', projectRoot]);
  git('config', 'user.email', 'tail@example.invalid');
  git('config', 'user.name', 'Memory Tail Test');
  await fs.writeFile(path.join(projectRoot, 'README.md'), '# tail\n');
  git('add', '.');
  git('commit', '-m', 'baseline');

  const started = await startProjectWorkflow({ projectRoot, goal: 'Recover completed tail records' });
  assert.equal(await recordOperationalToolFailure({
    tool: 'read_file',
    args: { path: path.join(projectRoot, 'missing.txt') },
    result: { content: [{ type: 'text', text: 'Error: ENOENT missing resource' }], isError: true },
  }), true);
  assert.equal((await getProjectWorkflowStatus({ projectRoot })).operationalMemory.totalEvents, 1);

  const memoryPath = resolveWorkflowMemoryPath(projectRoot);
  const [seedLine] = (await fs.readFile(memoryPath, 'utf8')).trim().split(/\r?\n/);
  const completed = JSON.stringify({
    ...JSON.parse(seedLine),
    id: 'completed-after-partial',
    occurredAt: new Date(Date.now() + 1000).toISOString(),
  }) + '\n';
  const splitAt = Math.floor(completed.length / 2);
  await fs.appendFile(memoryPath, completed.slice(0, splitAt), 'utf8');
  assert.equal(
    (await getProjectWorkflowStatus({ projectRoot })).operationalMemory.totalEvents,
    1,
    'an incomplete tail must not become model-facing',
  );
  await fs.appendFile(memoryPath, completed.slice(splitAt), 'utf8');
  const recovered = await getProjectWorkflowStatus({ projectRoot });
  assert.equal(recovered.workflowId, started.workflowId);
  assert.equal(recovered.operationalMemory.totalEvents, 2,
    'a completed tail record must be indexed instead of skipped by an old EOF checkpoint');
  console.log('PASS M2 recovers a JSONL record completed after an unterminated tail');
} finally {
  if (previousStateRoot === undefined) delete process.env.DESKTOP_COMMANDER_WORKFLOW_STATE_DIR;
  else process.env.DESKTOP_COMMANDER_WORKFLOW_STATE_DIR = previousStateRoot;
  await fs.rm(tempDir, { recursive: true, force: true });
}
