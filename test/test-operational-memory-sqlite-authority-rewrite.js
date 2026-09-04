/** RED: M2 must rebuild when the JSONL authority is rewritten with a different prefix. */
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

const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'dc-memory-m2-rewrite-'));
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
    id: 'memory-m2-rewrite',
    name: 'Operational Memory M2 rewrite',
    stages: [{ id: 'inspect', label: 'Inspect', required: true }],
  }, null, 2));
  execFileSync('git', ['init', projectRoot]);
  git('config', 'user.email', 'rewrite@example.invalid');
  git('config', 'user.name', 'Memory Rewrite Test');
  await fs.writeFile(path.join(projectRoot, 'README.md'), '# rewrite\n');
  git('add', '.');
  git('commit', '-m', 'baseline');

  await startProjectWorkflow({ projectRoot, goal: 'Keep SQLite subordinate to JSONL authority' });
  for (let i = 0; i < 2; i += 1) {
    assert.equal(await recordOperationalToolFailure({
      tool: 'read_file',
      args: { path: path.join(projectRoot, 'missing.txt') },
      result: { content: [{ type: 'text', text: 'Error: ENOENT missing resource' }], isError: true },
    }), true);
  }
  assert.equal((await getProjectWorkflowStatus({ projectRoot })).operationalMemory.totalEvents, 2);

  const memoryPath = resolveWorkflowMemoryPath(projectRoot);
  const originalText = await fs.readFile(memoryPath, 'utf8');
  const [seedLine] = originalText.trim().split(/\r?\n/);
  const replacement = JSON.stringify({
    ...JSON.parse(seedLine),
    id: 'replacement-authority-event',
    occurredAt: new Date(Date.now() + 2000).toISOString(),
    padding: 'x'.repeat(originalText.length + 128),
  }) + '\n';
  assert.ok(Buffer.byteLength(replacement) > Buffer.byteLength(originalText));
  await fs.writeFile(memoryPath, replacement, 'utf8');

  const status = await getProjectWorkflowStatus({ projectRoot });
  assert.equal(status.operationalMemory.totalEvents, 1,
    'rewriting JSONL with a different prefix must discard stale indexed events');
  assert.equal(status.operationalMemory.lessons[0].occurrences, 1);
  assert.equal(await recordOperationalToolFailure({
    tool: 'write_file',
    args: { path: path.join(projectRoot, 'denied.txt') },
    result: { content: [{ type: 'text', text: 'Error: EACCES permission denied' }], isError: true },
  }), true);
  assert.equal((await getProjectWorkflowStatus({ projectRoot })).operationalMemory.totalEvents, 2);

  const rewrittenBeforeAppend = JSON.stringify({
    ...JSON.parse(seedLine),
    id: 'replacement-before-append',
    occurredAt: new Date(Date.now() + 4000).toISOString(),
    padding: 'y'.repeat((await fs.stat(memoryPath)).size + 256),
  }) + '\n';
  await fs.writeFile(memoryPath, rewrittenBeforeAppend, 'utf8');
  assert.equal(await recordOperationalToolFailure({
    tool: 'read_file',
    args: { path: path.join(projectRoot, 'missing-after-rewrite.txt') },
    result: { content: [{ type: 'text', text: 'Error: ENOENT missing resource' }], isError: true },
  }), true);
  const afterRewriteAppend = await getProjectWorkflowStatus({ projectRoot });
  assert.equal(afterRewriteAppend.operationalMemory.totalEvents, 2,
    'rewrite followed by append must not legitimize stale SQLite rows');
  assert.equal(afterRewriteAppend.operationalMemory.lessons[0].occurrences, 2);
  console.log('PASS M2 rebuilds after JSONL authority rewrite and rewrite-before-append');
} finally {
  if (previousStateRoot === undefined) delete process.env.DESKTOP_COMMANDER_WORKFLOW_STATE_DIR;
  else process.env.DESKTOP_COMMANDER_WORKFLOW_STATE_DIR = previousStateRoot;
  await fs.rm(tempDir, { recursive: true, force: true });
}
