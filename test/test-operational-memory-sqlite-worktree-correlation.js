/** M2 regression: linked worktrees keep separate physical indexes but share stable scope IDs. */
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

let DatabaseSync;
try { ({ DatabaseSync } = await import('node:sqlite')); }
catch { console.log('SKIP M2 worktree correlation: node:sqlite unavailable'); process.exit(0); }

const workflow = await import('../dist/workflow/project-workflow.js');
const storage = await import('../dist/workflow/workflow-storage.js');
const scope = await import('../dist/workflow/scope-identity.js');
const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'dc-memory-m2-worktree-'));
const projectRoot = path.join(tempDir, 'repo');
const linkedRoot = path.join(tempDir, 'linked');
const stateRoot = path.join(tempDir, 'state');
const previousStateRoot = process.env.DESKTOP_COMMANDER_WORKFLOW_STATE_DIR;
process.env.DESKTOP_COMMANDER_WORKFLOW_STATE_DIR = stateRoot;

function gitAt(root, ...args) {
  return execFileSync('git', ['-C', root, ...args], { encoding: 'utf8' }).trim();
}
try {
  await fs.mkdir(path.join(projectRoot, '.desktop-commander'), { recursive: true });
  await fs.writeFile(path.join(projectRoot, '.desktop-commander', 'project-workflow.json'), JSON.stringify({
    version: 1,
    id: 'memory-m2-worktree',
    name: 'Operational Memory M2 worktree correlation',
    stages: [{ id: 'inspect', label: 'Inspect', required: true }],
  }, null, 2));
  execFileSync('git', ['init', projectRoot]);
  gitAt(projectRoot, 'config', 'user.email', 'worktree@example.invalid');
  gitAt(projectRoot, 'config', 'user.name', 'Memory Worktree Test');
  gitAt(projectRoot, 'remote', 'add', 'origin', 'https://github.com/example/memory-worktree.git');
  await fs.writeFile(path.join(projectRoot, 'README.md'), '# worktree\n');
  gitAt(projectRoot, 'add', '.');
  gitAt(projectRoot, 'commit', '-m', 'baseline');
  gitAt(projectRoot, 'worktree', 'add', '--detach', linkedRoot, 'HEAD');

  for (const root of [projectRoot, linkedRoot]) {
    await workflow.startProjectWorkflow({ projectRoot: root, goal: 'Prove stable scope across worktrees' });
    assert.equal(await workflow.recordOperationalToolFailure({
      tool: 'read_file',
      args: { path: path.join(root, 'missing.txt') },
      result: { content: [{ type: 'text', text: 'Error: ENOENT missing resource' }], isError: true },
    }), true);
    await workflow.getProjectWorkflowStatus({ projectRoot: root });
  }
  const primaryIdentity = await scope.resolveProjectIdentity(projectRoot);
  const linkedIdentity = await scope.resolveProjectIdentity(linkedRoot);
  assert.equal(linkedIdentity.projectId, primaryIdentity.projectId);
  assert.equal(linkedIdentity.repository.repositoryId, primaryIdentity.repository.repositoryId);

  const primaryIndex = storage.resolveWorkflowMemoryIndexPath(projectRoot);
  const linkedIndex = storage.resolveWorkflowMemoryIndexPath(linkedRoot);
  assert.notEqual(primaryIndex, linkedIndex, 'M2 keeps legacy path-keyed physical indexes until B9');

  for (const indexPath of [primaryIndex, linkedIndex]) {
    const db = new DatabaseSync(indexPath, { readOnly: true });
    try {
      const state = db.prepare('SELECT project_id, repository_id FROM index_state WHERE id = 1').get();
      assert.equal(state.project_id, primaryIdentity.projectId);
      assert.equal(state.repository_id, primaryIdentity.repository.repositoryId);
    } finally {
      db.close();
    }
  }
  console.log('PASS M2 linked worktrees share stable scope correlation');
} finally {
  if (previousStateRoot === undefined) delete process.env.DESKTOP_COMMANDER_WORKFLOW_STATE_DIR;
  else process.env.DESKTOP_COMMANDER_WORKFLOW_STATE_DIR = previousStateRoot;
  await fs.rm(tempDir, { recursive: true, force: true });
}
