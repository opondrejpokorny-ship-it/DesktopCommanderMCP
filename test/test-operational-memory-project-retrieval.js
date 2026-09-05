/** RED -> GREEN tests for M3A project-scoped Operational Memory retrieval. */
import assert from 'node:assert';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import {
  getProjectWorkflowStatus,
  recordOperationalLesson,
  resumeProjectWorkflow,
  resolveWorkflowMemoryPath,
  startProjectWorkflow,
} from '../dist/workflow/project-workflow.js';

const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'dc-memory-m3a-'));
const projectRoot = path.join(tempDir, 'repo');
const stateRoot = path.join(tempDir, 'state');
const profileDir = path.join(projectRoot, '.desktop-commander');
const previousStateRoot = process.env.DESKTOP_COMMANDER_WORKFLOW_STATE_DIR;

function git(...args) {
  return execFileSync('git', ['-C', projectRoot, ...args], { encoding: 'utf8' }).trim();
}
try {
  process.env.DESKTOP_COMMANDER_WORKFLOW_STATE_DIR = stateRoot;
  await fs.mkdir(profileDir, { recursive: true });
  await fs.writeFile(
    path.join(profileDir, 'project-workflow.json'),
    JSON.stringify({
      version: 1,
      id: 'memory-m3a-test',
      name: 'Operational Memory M3A test',
      stages: [
        { id: 'inspect', label: 'Inspect', required: true },
        { id: 'verify', label: 'Verify', required: true },
      ],
    }, null, 2),
  );

  execFileSync('git', ['init', projectRoot]);
  git('config', 'user.email', 'test@example.invalid');
  git('config', 'user.name', 'Operational Memory M3A Test');
  git('remote', 'add', 'origin', 'https://github.com/example/m3a-same-root.git');
  await fs.writeFile(path.join(projectRoot, 'README.md'), '# m3a\n');
  git('add', '.');
  git('commit', '-m', 'baseline');

  const first = await startProjectWorkflow({ projectRoot, goal: 'First task' });
  assert.ok(first.taskId);
  assert.ok(first.runId);
  assert.strictEqual(first.workflowId, first.taskId);
  const firstRunId = first.runId;
  const learned = await recordOperationalLesson({
    projectRoot,
    lessonCode: 'fetch_required_git_refs',
  });
  assert.strictEqual(learned, true);

  const memoryPath = resolveWorkflowMemoryPath(projectRoot);
  const firstEvent = JSON.parse((await fs.readFile(memoryPath, 'utf8')).trim());
  assert.strictEqual(firstEvent.workflowId, first.taskId);
  assert.strictEqual(firstEvent.taskId, first.taskId, 'v2 event must persist server-owned TaskId');
  assert.strictEqual(firstEvent.runId, firstRunId, 'v2 event must persist server-owned RunId');

  const resumed = await resumeProjectWorkflow({ projectRoot });
  assert.strictEqual(resumed.taskId, first.taskId);
  assert.notStrictEqual(resumed.runId, firstRunId);
  let fetchLessons = resumed.operationalMemory.lessons.filter(
    (lesson) => lesson.lessonCode === 'fetch_required_git_refs',
  );
  assert.strictEqual(fetchLessons.length, 1);
  assert.strictEqual(fetchLessons[0].scope, 'workflow');
  assert.strictEqual(fetchLessons[0].relevanceReason, 'current_task_history');
  await recordOperationalLesson({
    projectRoot,
    lessonCode: 'fetch_required_git_refs',
  });
  let status = await getProjectWorkflowStatus({ projectRoot });
  fetchLessons = status.operationalMemory.lessons.filter(
    (lesson) => lesson.lessonCode === 'fetch_required_git_refs',
  );
  assert.strictEqual(fetchLessons.length, 1, 'same fingerprint must be model-facing once');
  assert.strictEqual(fetchLessons[0].scope, 'workflow');
  assert.strictEqual(fetchLessons[0].relevanceReason, 'current_run_exact_stage');

  const second = await startProjectWorkflow({
    projectRoot,
    goal: 'Second task',
    restart: true,
  });
  assert.notStrictEqual(second.taskId, first.taskId);
  assert.notStrictEqual(second.runId, resumed.runId);
  fetchLessons = second.operationalMemory.lessons.filter(
    (lesson) => lesson.lessonCode === 'fetch_required_git_refs',
  );
  assert.strictEqual(fetchLessons.length, 1, 'new Task must inherit same-project history');
  assert.strictEqual(fetchLessons[0].scope, 'project');
  assert.strictEqual(fetchLessons[0].relevanceReason, 'project_exact_stage');
  const lessonCodes = [
    'enforcement_before_consuming_preflight',
    'client_provenance_untrusted',
    'tooling_availability_check',
    'shell_quoting_unreliable',
    'tool_timeout_not_test_failure',
    'flaky_test_isolate',
    'connection_generation_guard',
    'parallel_checkout_conflict',
    'child_env_wrapper_required',
  ];
  for (const lessonCode of lessonCodes) {
    assert.strictEqual(await recordOperationalLesson({ projectRoot, lessonCode }), true);
  }
  status = await getProjectWorkflowStatus({ projectRoot });
  assert.ok(status.operationalMemory.lessons.length <= 8, 'model-facing context must stay capped at 8');
  for (const lesson of status.operationalMemory.lessons) {
    assert.ok(['workflow', 'project'].includes(lesson.scope));
    assert.match(lesson.relevanceReason, /^[a-z0-9_]+$/);
  }

  await recordOperationalLesson({
    projectRoot,
    lessonCode: 'fetch_required_git_refs',
  });
  status = await getProjectWorkflowStatus({ projectRoot });
  fetchLessons = status.operationalMemory.lessons.filter(
    (lesson) => lesson.lessonCode === 'fetch_required_git_refs',
  );
  assert.strictEqual(fetchLessons.length, 1);
  assert.strictEqual(fetchLessons[0].scope, 'workflow');
  assert.strictEqual(fetchLessons[0].relevanceReason, 'current_run_exact_stage');

  console.log('✅ Operational Memory M3A project retrieval tests passed');
} finally {
  if (previousStateRoot === undefined) {
    delete process.env.DESKTOP_COMMANDER_WORKFLOW_STATE_DIR;
  } else {
    process.env.DESKTOP_COMMANDER_WORKFLOW_STATE_DIR = previousStateRoot;
  }
  await fs.rm(tempDir, { recursive: true, force: true });
}
