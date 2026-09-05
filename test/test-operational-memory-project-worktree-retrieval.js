import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import * as workflow from '../dist/workflow/project-workflow.js';
import * as storage from '../dist/workflow/workflow-storage.js';

const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'dc-memory-m3a-worktree-'));
const primary = path.join(tempDir, 'repo');
const linked = path.join(tempDir, 'linked');
const linked2 = path.join(tempDir, 'linked-2');
const other = path.join(tempDir, 'other');
const stateRoot = path.join(tempDir, 'state');
const previousStateRoot = process.env.DESKTOP_COMMANDER_WORKFLOW_STATE_DIR;
process.env.DESKTOP_COMMANDER_WORKFLOW_STATE_DIR = stateRoot;
function git(root, ...args) {
  return execFileSync('git', ['-C', root, ...args], { encoding: 'utf8' }).trim();
}
async function initRepo(root, origin, profileId) {
  await fs.mkdir(path.join(root, '.desktop-commander'), { recursive: true });
  await fs.writeFile(path.join(root, '.desktop-commander', 'project-workflow.json'), JSON.stringify({
    version: 1, id: profileId, name: profileId,
    stages: [{ id: 'inspect', label: 'Inspect', required: true }],
  }, null, 2));
  execFileSync('git', ['init', root]);  git(root, 'config', 'user.email', 'm3a@example.invalid');
  git(root, 'config', 'user.name', 'M3A Test');
  git(root, 'remote', 'add', 'origin', origin);
  await fs.writeFile(path.join(root, 'README.md'), `# ${profileId}\n`);
  git(root, 'add', '.');
  git(root, 'commit', '-m', 'baseline');
}
try {
  await initRepo(primary, 'https://github.com/example/m3a-primary.git', 'm3a-primary');
  git(primary, 'worktree', 'add', '--detach', linked, 'HEAD');
  git(primary, 'worktree', 'add', '--detach', linked2, 'HEAD');
  await initRepo(other, 'https://github.com/example/m3a-other.git', 'm3a-other');

  await workflow.startProjectWorkflow({ projectRoot: primary, goal: 'Primary task' });
  assert.equal(await workflow.recordOperationalLesson({
    projectRoot: primary, lessonCode: 'fetch_required_git_refs',
  }), true);
  await workflow.getProjectWorkflowStatus({ projectRoot: primary });

  await workflow.startProjectWorkflow({ projectRoot: other, goal: 'Other task' });
  assert.equal(await workflow.recordOperationalLesson({
    projectRoot: other, lessonCode: 'shell_quoting_unreliable',
  }), true);
  await workflow.getProjectWorkflowStatus({ projectRoot: other });
  const corruptIndex = path.join(stateRoot, 'corrupt-candidate.memory.sqlite');
  await fs.writeFile(corruptIndex, 'NOT_SQLITE_M3A_MARKER');
  const corruptBefore = await fs.readFile(corruptIndex);
  const otherIndex = storage.resolveWorkflowMemoryIndexPath(other);
  const otherBefore = await fs.readFile(otherIndex);
  const otherStatBefore = await fs.stat(otherIndex);

  const linkedStart = await workflow.startProjectWorkflow({ projectRoot: linked, goal: 'Linked task' });
  const inherited = linkedStart.operationalMemory.lessons.filter(
    (lesson) => lesson.lessonCode === 'fetch_required_git_refs',
  );
  assert.equal(inherited.length, 1, 'linked worktree must inherit same-project history');
  assert.equal(inherited[0].scope, 'project');
  assert.equal(await workflow.recordOperationalLesson({
    projectRoot: linked, lessonCode: 'fetch_required_git_refs',
  }), true);
  await workflow.getProjectWorkflowStatus({ projectRoot: linked });
  const linked2Start = await workflow.startProjectWorkflow({ projectRoot: linked2, goal: 'Second linked task' });
  const inheritedAcrossIndexes = linked2Start.operationalMemory.lessons.filter(
    (lesson) => lesson.lessonCode === 'fetch_required_git_refs',
  );
  assert.equal(inheritedAcrossIndexes.length, 1, 'same fingerprint across project indexes must dedupe');
  assert.equal(inheritedAcrossIndexes[0].occurrences, 2, 'project occurrences must aggregate across linked-worktree indexes');
  assert.equal(inheritedAcrossIndexes[0].scope, 'project');
  assert.equal(
    linkedStart.operationalMemory.lessons.some((lesson) => lesson.lessonCode === 'shell_quoting_unreliable'),
    false,
    'different project history must not leak',
  );

  const corruptAfter = await fs.readFile(corruptIndex);
  assert.deepEqual(corruptAfter, corruptBefore, 'corrupt unidentifiable candidate must be skipped without rewrite');
  const otherAfter = await fs.readFile(otherIndex);
  const otherStatAfter = await fs.stat(otherIndex);
  assert.deepEqual(otherAfter, otherBefore, 'mismatched project index must not be rewritten during discovery');
  assert.equal(otherStatAfter.mtimeMs, otherStatBefore.mtimeMs, 'mismatched project index mtime must stay unchanged');
  console.log('PASS M3A linked-worktree retrieval and cross-project isolation');
} finally {
  if (previousStateRoot === undefined) delete process.env.DESKTOP_COMMANDER_WORKFLOW_STATE_DIR;
  else process.env.DESKTOP_COMMANDER_WORKFLOW_STATE_DIR = previousStateRoot;
  await fs.rm(tempDir, { recursive: true, force: true });
}
