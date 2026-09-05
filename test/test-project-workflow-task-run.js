/**
 * RED -> GREEN contract for Scope B4 TaskId / RunId workflow identity.
 */
import assert from 'node:assert';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import {
  finishProjectWorkflow,
  getProjectWorkflowStatus,
  recordProjectWorkflowStage,
  resolveWorkflowStatePath,
  resumeProjectWorkflow,
  startProjectWorkflow,
} from '../dist/workflow/project-workflow.js';

const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'dc-b4-task-run-'));
const projectRoot = path.join(tempDir, 'repo');
const stateRoot = path.join(tempDir, 'state');
const profileDir = path.join(projectRoot, '.desktop-commander');
const profilePath = path.join(profileDir, 'project-workflow.json');

function git(cwd, ...args) {
  return execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8' }).trim();
}
try {
  process.env.DESKTOP_COMMANDER_WORKFLOW_STATE_DIR = stateRoot;
  await fs.mkdir(profileDir, { recursive: true });
  await fs.writeFile(profilePath, JSON.stringify({
    version: 1,
    id: 'b4-task-run',
    name: 'B4 Task/Run test',
    stages: [{ id: 'verify', label: 'Verify', required: true }]
  }, null, 2));
  execFileSync('git', ['init', projectRoot]);
  git(projectRoot, 'config', 'user.email', 'test@example.invalid');
  git(projectRoot, 'config', 'user.name', 'B4 Test');
  await fs.writeFile(path.join(projectRoot, 'README.md'), '# B4\n');
  git(projectRoot, 'add', '.');
  git(projectRoot, 'commit', '-m', 'baseline');
  git(projectRoot, 'remote', 'add', 'origin', 'https://example.invalid/acme/b4.git');

  const first = await startProjectWorkflow({ projectRoot, goal: 'First task' });
  assert.strictEqual(first.workflowId, first.taskId);
  assert.match(first.taskId, /^[0-9a-f-]{36}$/i);
  assert.match(first.runId, /^[0-9a-f-]{36}$/i);
  assert.notStrictEqual(first.taskId, first.runId);

  const firstStatus = await getProjectWorkflowStatus({ projectRoot });
  assert.strictEqual(firstStatus.taskId, first.taskId);
  assert.strictEqual(firstStatus.runId, first.runId);

  const restarted = await startProjectWorkflow({
    projectRoot,
    goal: 'Restarted task',
    restart: true
  });
  assert.notStrictEqual(restarted.taskId, first.taskId);
  assert.notStrictEqual(restarted.runId, first.runId);
  assert.strictEqual(restarted.workflowId, restarted.taskId);

  const statePath = resolveWorkflowStatePath(projectRoot);
  const v2 = JSON.parse(await fs.readFile(statePath, 'utf8'));
  assert.strictEqual(v2.version, 2);
  assert.strictEqual(v2.taskId, restarted.taskId);
  assert.strictEqual(v2.runId, restarted.runId);

  const legacy = { ...v2, version: 1 };
  delete legacy.taskId;
  delete legacy.runId;
  await fs.writeFile(statePath, JSON.stringify(legacy, null, 2));
  const beforeLegacyStatus = await fs.readFile(statePath, 'utf8');
  const legacyStatus = await getProjectWorkflowStatus({ projectRoot });
  assert.strictEqual(legacyStatus.taskId, legacy.workflowId);
  assert.strictEqual(legacyStatus.runId, undefined);
  assert.strictEqual(await fs.readFile(statePath, 'utf8'), beforeLegacyStatus);

  const legacyRecord = await recordProjectWorkflowStage({
    projectRoot,
    stageId: 'verify',
    status: 'blocked',
    reason: 'External dependency'
  });
  assert.strictEqual(legacyRecord.taskId, legacy.workflowId);
  assert.strictEqual(legacyRecord.runId, undefined);
  const afterLegacyRecord = JSON.parse(await fs.readFile(statePath, 'utf8'));
  assert.strictEqual(afterLegacyRecord.version, 1);
  assert.ok(!Object.hasOwn(afterLegacyRecord, 'runId'));

  const resumedLegacy = await resumeProjectWorkflow({ projectRoot });
  assert.strictEqual(resumedLegacy.workflowId, legacy.workflowId);
  assert.strictEqual(resumedLegacy.taskId, legacy.workflowId);
  assert.match(resumedLegacy.runId, /^[0-9a-f-]{36}$/i);
  const upgraded = JSON.parse(await fs.readFile(statePath, 'utf8'));
  assert.strictEqual(upgraded.version, 2);
  assert.strictEqual(upgraded.taskId, legacy.workflowId);
  assert.strictEqual(upgraded.runId, resumedLegacy.runId);

  const resumedAgain = await resumeProjectWorkflow({ projectRoot });
  assert.strictEqual(resumedAgain.taskId, resumedLegacy.taskId);
  assert.strictEqual(resumedAgain.workflowId, resumedLegacy.workflowId);
  assert.notStrictEqual(resumedAgain.runId, resumedLegacy.runId);

  await recordProjectWorkflowStage({
    projectRoot,
    stageId: 'verify',
    status: 'completed',
    evidence: { kind: 'agent_attestation', summary: 'Verified.' }
  });
  const finished = await finishProjectWorkflow({ projectRoot });
  const nextTask = await startProjectWorkflow({ projectRoot, goal: 'Next task' });
  assert.notStrictEqual(nextTask.taskId, finished.taskId);
  assert.notStrictEqual(nextTask.runId, finished.runId);
  assert.strictEqual(nextTask.workflowId, nextTask.taskId);

  const mismatched = JSON.parse(await fs.readFile(statePath, 'utf8'));
  mismatched.workflowId = '00000000-0000-4000-8000-000000000000';
  await fs.writeFile(statePath, JSON.stringify(mismatched, null, 2));
  await assert.rejects(
    () => getProjectWorkflowStatus({ projectRoot }),
    /workflow.*task|task.*workflow|invalid/i
  );

  const restored = {
    ...mismatched,
    workflowId: mismatched.taskId
  };
  await fs.writeFile(statePath, JSON.stringify(restored, null, 2));

  const malformedTask = {
    ...restored,
    workflowId: 'not-a-uuid',
    taskId: 'not-a-uuid'
  };
  await fs.writeFile(statePath, JSON.stringify(malformedTask, null, 2));
  await assert.rejects(
    () => getProjectWorkflowStatus({ projectRoot }),
    /task.*invalid|uuid|scope.*id/i
  );

  const malformedRun = {
    ...restored,
    runId: 'not-a-uuid'
  };
  await fs.writeFile(statePath, JSON.stringify(malformedRun, null, 2));
  await assert.rejects(
    () => getProjectWorkflowStatus({ projectRoot }),
    /run.*invalid|uuid|scope.*id/i
  );

  await fs.writeFile(statePath, JSON.stringify(restored, null, 2));

  const workerRoot = path.join(tempDir, 'worker');
  git(projectRoot, 'worktree', 'add', '-b', 'b4-worker', workerRoot);
  const worker = await startProjectWorkflow({
    projectRoot: workerRoot,
    goal: 'Worker task'
  });
  assert.strictEqual(
    worker.projectIdentity.projectId,
    nextTask.projectIdentity.projectId
  );
  assert.strictEqual(
    worker.projectIdentity.repository.repositoryId,
    nextTask.projectIdentity.repository.repositoryId
  );
  assert.notStrictEqual(worker.statePath, nextTask.statePath);
  assert.notStrictEqual(worker.taskId, nextTask.taskId);
  assert.notStrictEqual(worker.runId, nextTask.runId);

  console.log('✅ Scope B4 Task/Run workflow tests passed');
} finally {
  delete process.env.DESKTOP_COMMANDER_WORKFLOW_STATE_DIR;
  await fs.rm(tempDir, { recursive: true, force: true });
}
