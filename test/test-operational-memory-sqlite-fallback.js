/** M2 regression: Operational Memory remains functional when node:sqlite is unavailable. */
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs/promises';
import Module from 'node:module';
import os from 'node:os';
import path from 'node:path';

const originalLoad = Module._load;
Module._load = function(request, parent, isMain) {
  if (request === 'node:sqlite') {
    const error = new Error('simulated unsupported node:sqlite runtime');
    error.code = 'ERR_UNKNOWN_BUILTIN_MODULE';
    throw error;
  }
  return originalLoad.call(this, request, parent, isMain);
};

const workflow = await import('../dist/workflow/project-workflow.js');
const storage = await import('../dist/workflow/workflow-storage.js');
const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'dc-memory-m2-fallback-'));
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
      id: 'memory-m2-fallback',
      name: 'Operational Memory M2 fallback',
      stages: [{ id: 'inspect', label: 'Inspect', required: true }],
    }, null, 2),
  );
  execFileSync('git', ['init', projectRoot]);
  execFileSync('git', ['-C', projectRoot, 'config', 'user.email', 'fallback@example.invalid']);
  execFileSync('git', ['-C', projectRoot, 'config', 'user.name', 'Memory Fallback Test']);
  await fs.writeFile(path.join(projectRoot, 'README.md'), '# fallback\n');
  execFileSync('git', ['-C', projectRoot, 'add', '.']);
  execFileSync('git', ['-C', projectRoot, 'commit', '-m', 'baseline']);

  const started = await workflow.startProjectWorkflow({
    projectRoot,
    goal: 'Keep JSONL retrieval working without SQLite',
  });
  assert.equal(
    await workflow.recordOperationalToolFailure({
      tool: 'read_file',
      args: { path: path.join(projectRoot, 'missing.txt') },
      result: { content: [{ type: 'text', text: 'Error: ENOENT missing resource' }], isError: true },
    }),
    true,
  );
  const status = await workflow.getProjectWorkflowStatus({ projectRoot });
  assert.equal(status.workflowId, started.workflowId);
  assert.equal(status.operationalMemory.totalEvents, 1);
  assert.equal(status.operationalMemory.lessons[0].occurrences, 1);
  assert.equal(
    await fs.stat(storage.resolveWorkflowMemoryIndexPath(projectRoot)).then(() => true, () => false),
    false,
    'unsupported SQLite runtime must fall back without creating an index',
  );
  assert.equal(
    await fs.stat(workflow.resolveWorkflowMemoryPath(projectRoot)).then(() => true, () => false),
    true,
    'JSONL journal remains authoritative',
  );
  console.log('✅ Operational Memory M2 SQLite-unavailable fallback passed');
} finally {
  Module._load = originalLoad;
  if (previousStateRoot === undefined) delete process.env.DESKTOP_COMMANDER_WORKFLOW_STATE_DIR;
  else process.env.DESKTOP_COMMANDER_WORKFLOW_STATE_DIR = previousStateRoot;
  await fs.rm(tempDir, { recursive: true, force: true });
}
