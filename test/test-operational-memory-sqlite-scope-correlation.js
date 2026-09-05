/** RED: M2 index state must reuse shared B1/B2 ProjectId/RepositoryId correlation. */
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

let DatabaseSync;
try {
  ({ DatabaseSync } = await import('node:sqlite'));
} catch {
  console.log('SKIP M2 scope correlation: node:sqlite unavailable on this supported runtime');
  process.exit(0);
}

const workflow = await import('../dist/workflow/project-workflow.js');
const storage = await import('../dist/workflow/workflow-storage.js');
const scope = await import('../dist/workflow/scope-identity.js');
const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'dc-memory-m2-scope-'));
const projectRoot = path.join(tempDir, 'repo');
const stateRoot = path.join(tempDir, 'state');
const previousStateRoot = process.env.DESKTOP_COMMANDER_WORKFLOW_STATE_DIR;
process.env.DESKTOP_COMMANDER_WORKFLOW_STATE_DIR = stateRoot;

try {
  await fs.mkdir(path.join(projectRoot, '.desktop-commander'), { recursive: true });
  await fs.writeFile(path.join(projectRoot, '.desktop-commander', 'project-workflow.json'), JSON.stringify({
    version: 1,
    id: 'memory-m2-scope',
    name: 'Operational Memory M2 scope correlation',    stages: [{ id: 'inspect', label: 'Inspect', required: true }],
  }, null, 2));
  execFileSync('git', ['init', projectRoot]);
  execFileSync('git', ['-C', projectRoot, 'config', 'user.email', 'scope@example.invalid']);
  execFileSync('git', ['-C', projectRoot, 'config', 'user.name', 'Memory Scope Test']);
  execFileSync('git', ['-C', projectRoot, 'remote', 'add', 'origin', 'https://github.com/example/memory-scope.git']);
  await fs.writeFile(path.join(projectRoot, 'README.md'), '# scope\n');
  execFileSync('git', ['-C', projectRoot, 'add', '.']);
  execFileSync('git', ['-C', projectRoot, 'commit', '-m', 'baseline']);

  await workflow.startProjectWorkflow({ projectRoot, goal: 'Reuse stable scope correlation' });
  assert.equal(await workflow.recordOperationalToolFailure({
    tool: 'read_file',
    args: { path: path.join(projectRoot, 'missing.txt') },
    result: { content: [{ type: 'text', text: 'Error: ENOENT missing resource' }], isError: true },
  }), true);
  await workflow.getProjectWorkflowStatus({ projectRoot });
  const identity = await scope.resolveProjectIdentity(projectRoot);
  const db = new DatabaseSync(storage.resolveWorkflowMemoryIndexPath(projectRoot), { readOnly: true });
  const columns = db.prepare('PRAGMA table_info(index_state)').all().map((row) => row.name);
  const state = db.prepare('SELECT * FROM index_state WHERE id = 1').get();
  db.close();
  assert.ok(columns.includes('project_id'), 'index_state must contain project_id correlation metadata');
  assert.ok(columns.includes('repository_id'), 'index_state must contain repository_id correlation metadata');
  assert.equal(state.project_id, identity.projectId);
  assert.equal(state.repository_id, identity.repository.repositoryId);
  console.log('PASS M2 index state stores shared scope correlation metadata');
} finally {
  if (previousStateRoot === undefined) delete process.env.DESKTOP_COMMANDER_WORKFLOW_STATE_DIR;
  else process.env.DESKTOP_COMMANDER_WORKFLOW_STATE_DIR = previousStateRoot;
  await fs.rm(tempDir, { recursive: true, force: true });
}
