import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import * as workflow from '../dist/workflow/project-workflow.js';
import * as globalIndex from '../dist/workflow/operational-memory-global-index.js';
import * as storage from '../dist/workflow/workflow-storage.js';

const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'dc-memory-m3b-global-'));
const stateRoot = path.join(tempDir, 'state');
const projectA = path.join(tempDir, 'project-a');
const linkedA = path.join(tempDir, 'project-a-linked');
const projectB = path.join(tempDir, 'project-b');
const projectC = path.join(tempDir, 'project-c');
const previousStateRoot = process.env.DESKTOP_COMMANDER_WORKFLOW_STATE_DIR;
process.env.DESKTOP_COMMANDER_WORKFLOW_STATE_DIR = stateRoot;

function git(root, ...args) {
  return execFileSync('git', ['-C', root, ...args], { encoding: 'utf8' }).trim();
}

async function initRepo(root, origin, firstStage = 'inspect') {
  await fs.mkdir(path.join(root, '.desktop-commander'), { recursive: true });
  await fs.writeFile(path.join(root, '.desktop-commander', 'project-workflow.json'), JSON.stringify({
    version: 1,
    id: 'm3b-' + path.basename(root),
    name: 'M3B ' + path.basename(root),
    stages: [{ id: firstStage, label: firstStage, required: true }],
  }, null, 2));
  execFileSync('git', ['init', root]);
  git(root, 'config', 'user.email', 'm3b@example.invalid');
  git(root, 'config', 'user.name', 'M3B Test');
  git(root, 'remote', 'add', 'origin', origin);
  await fs.writeFile(path.join(root, 'README.md'), '# m3b\n');
  git(root, 'add', '.');
  git(root, 'commit', '-m', 'baseline');
}

function lesson(status, code) {
  return status.operationalMemory.lessons.find((item) => item.lessonCode === code);
}

try {
  await initRepo(projectA, 'https://github.com/example/m3b-a.git', 'source');
  git(projectA, 'worktree', 'add', '--detach', linkedA, 'HEAD');
  await initRepo(projectB, 'https://github.com/example/m3b-b.git', 'inspect');
  await initRepo(projectC, 'https://github.com/example/m3b-c.git', 'source');

  await workflow.startProjectWorkflow({ projectRoot: projectA, goal: 'Seed safe global lessons' });
  const safeCodes = [
    'fetch_required_git_refs',
    'shell_quoting_unreliable',
    'tooling_availability_check',
    'tool_timeout_not_test_failure',
    'flaky_test_isolate',
    'connection_generation_guard',
    'child_env_wrapper_required',
    'governance_recheck_before_side_effect',
    'per_action_preflight_required',
  ];
  for (const code of safeCodes) {
    assert.equal(await workflow.recordOperationalLesson({ projectRoot: projectA, lessonCode: code }), true);
  }
  for (let index = 0; index < 30; index += 1) {
    assert.equal(await workflow.recordOperationalLesson({
      projectRoot: projectA, lessonCode: 'shell_quoting_unreliable',
    }), true);
  }
  assert.equal(await workflow.recordOperationalToolFailure({
    tool: 'read_file',
    args: { path: path.join(projectA, 'missing.txt') },
    result: { content: [{ type: 'text', text: 'Error: ENOENT missing resource' }], isError: true },
  }), true);
  await workflow.getProjectWorkflowStatus({ projectRoot: projectA });
  assert.equal(await workflow.recordOperationalLesson({
    projectRoot: projectA, lessonCode: 'parallel_checkout_conflict',
  }), true);
  await workflow.getProjectWorkflowStatus({ projectRoot: projectA });

  await workflow.startProjectWorkflow({ projectRoot: linkedA, goal: 'Linked same-project seed' });
  assert.equal(await workflow.recordOperationalLesson({
    projectRoot: linkedA, lessonCode: 'parallel_checkout_conflict',
  }), true);
  await workflow.getProjectWorkflowStatus({ projectRoot: linkedA });

  const projectAIndex = storage.resolveWorkflowMemoryIndexPath(projectA);
  const db = new DatabaseSync(projectAIndex);
  try {
    db.prepare(`INSERT INTO project_groups
      (fingerprint, kind, reason_code, lesson_code, source_tool, family, stage_id,
       first_seen_at, last_seen_at, occurrences, distinct_workflows, latest_workflow_id, latest_record_sequence)
      VALUES (?, 'lesson', 'learned_pattern', ?, 'project_workflow', 'workflow', 'source',
       ?, ?, 1, 1, ?, 999999)`).run(
      'PRIVATE_INVALID_FINGERPRINT', 'PRIVATE_INVALID_LESSON_CODE',
      '2026-09-05T00:00:00.000Z', '2026-09-05T00:00:00.000Z',
      '00000000-0000-4000-8000-000000000001',
    );
    const spoofFingerprint = crypto.createHash('sha256')
      .update(['lesson', 'read_file', 'learned_pattern', 'filesystem.read', 'fetch_required_git_refs'].join('|'))
      .digest('hex').slice(0, 24);
    db.prepare(`INSERT INTO project_groups
      (fingerprint, kind, reason_code, lesson_code, source_tool, family, stage_id,
       first_seen_at, last_seen_at, occurrences, distinct_workflows, latest_workflow_id, latest_record_sequence)
      VALUES (?, 'lesson', 'learned_pattern', 'fetch_required_git_refs', 'read_file', 'filesystem.read', 'source',
       ?, ?, 1, 1, ?, 999998)`).run(
      spoofFingerprint, '2026-09-05T00:00:00.000Z', '2026-09-05T00:00:00.000Z',
      '00000000-0000-4000-8000-000000000002',
    );
    const derivedOnlyFingerprint = crypto.createHash('sha256')
      .update(['lesson', 'project_workflow', 'learned_pattern', 'workflow', 'client_provenance_untrusted'].join('|'))
      .digest('hex').slice(0, 24);
    db.prepare(`INSERT INTO project_groups
      (fingerprint, kind, reason_code, lesson_code, source_tool, family, stage_id,
       first_seen_at, last_seen_at, occurrences, distinct_workflows, latest_workflow_id, latest_record_sequence)
      VALUES (?, 'lesson', 'learned_pattern', 'client_provenance_untrusted', 'project_workflow', 'workflow', 'source',
       ?, ?, 1, 1, ?, 999997)`).run(
      derivedOnlyFingerprint, '2026-09-05T00:00:00.000Z', '2026-09-05T00:00:00.000Z',
      '00000000-0000-4000-8000-000000000003',
    );  } finally {
    db.close();
  }
  const projectABytesBefore = await fs.readFile(projectAIndex);
  const projectAStatBefore = await fs.stat(projectAIndex);
  const corruptIndex = path.join(stateRoot, 'm3b-corrupt.memory.sqlite');
  await fs.writeFile(corruptIndex, 'NOT_SQLITE_M3B_PRIVATE_MARKER');
  const corruptBefore = await fs.readFile(corruptIndex);

  const firstB = await workflow.startProjectWorkflow({
    projectRoot: projectB, goal: 'Consume safe global lessons',
  });
  const inheritedGlobals = firstB.operationalMemory.lessons.filter((item) => item.scope === 'global');
  assert.ok(inheritedGlobals.length > 0, 'unrelated project should inherit whitelisted semantic lessons');
  assert.ok(inheritedGlobals.every((item) =>
    item.reasonCode === 'learned_pattern' &&
    item.sourceTool === 'project_workflow' &&
    item.family === 'workflow' &&
    (safeCodes.includes(item.lessonCode) || item.lessonCode === 'parallel_checkout_conflict')
  ), 'every inherited global lesson must be a server-whitelisted semantic lesson');
  assert.ok(inheritedGlobals.every((item) => item.relevanceReason.startsWith('global_')));
  assert.ok(firstB.operationalMemory.lessons.length <= 8, 'global retrieval must preserve the hard cap');
  assert.equal(
    firstB.operationalMemory.lessons.some((item) => item.reasonCode === 'not_found'),
    false,
    'ordinary tool failures must never cross project boundaries',
  );
  assert.equal(
    JSON.stringify(firstB.operationalMemory).includes('PRIVATE_INVALID_LESSON_CODE'),
    false,
    'non-whitelisted learned-pattern rows must never surface globally',
  );
  assert.equal(
    firstB.operationalMemory.lessons.some((item) =>
      item.lessonCode === 'fetch_required_git_refs' && item.sourceTool !== 'project_workflow'
    ),
    false,
    'valid lesson codes spoofed through a non-project_workflow tool must never surface globally',
  );
  assert.equal(
    firstB.operationalMemory.lessons.some((item) => item.lessonCode === 'client_provenance_untrusted'),
    false,
    'a valid-looking derived SQLite row without JSONL authority must never surface globally',
  );

  const globalIndexPath = globalIndex.resolveOperationalMemoryGlobalIndexPath();
  const globalBytes = await fs.readFile(globalIndexPath);
  const globalText = globalBytes.toString('latin1');
  for (const forbidden of [tempDir, projectA, linkedA, projectB, 'PRIVATE_INVALID_LESSON_CODE', 'NOT_SQLITE_M3B_PRIVATE_MARKER']) {
    assert.equal(globalText.includes(forbidden), false, `global index leaked forbidden marker: ${forbidden}`);
  }

  await fs.writeFile(globalIndexPath, 'NOT_SQLITE_GLOBAL_PRIVATE_MARKER');
  const recoveredAfterCorruption = await workflow.getProjectWorkflowStatus({ projectRoot: projectB });
  assert.ok(recoveredAfterCorruption.operationalMemory.lessons.some((item) => item.scope === 'global'),
    'corrupt global SQLite must rebuild from authoritative journals');
  assert.equal((await fs.readFile(globalIndexPath)).toString('latin1').includes('NOT_SQLITE_GLOBAL_PRIVATE_MARKER'), false);

  await fs.rm(globalIndexPath, { force: true });
  const recoveredAfterDelete = await workflow.getProjectWorkflowStatus({ projectRoot: projectB });
  assert.ok(recoveredAfterDelete.operationalMemory.lessons.some((item) => item.scope === 'global'),
    'missing global SQLite must rebuild from authoritative journals');
  assert.deepEqual(await fs.readFile(projectAIndex), projectABytesBefore,
    'global discovery must not rewrite a foreign project index');
  assert.equal((await fs.stat(projectAIndex)).mtimeMs, projectAStatBefore.mtimeMs,
    'global discovery must preserve foreign index mtime');
  assert.deepEqual(await fs.readFile(corruptIndex), corruptBefore,
    'corrupt foreign candidates must be skipped without rewrite');

  assert.equal(await workflow.recordOperationalLesson({
    projectRoot: projectB, lessonCode: 'fetch_required_git_refs',
  }), true);
  await workflow.getProjectWorkflowStatus({ projectRoot: projectB });
  const secondB = await workflow.startProjectWorkflow({
    projectRoot: projectB, goal: 'Project history must outrank global', restart: true,
  });
  assert.equal(lesson(secondB, 'fetch_required_git_refs')?.scope, 'project',
    'same-project history must win deduplication over global history');

  assert.equal(await workflow.recordOperationalLesson({
    projectRoot: projectB, lessonCode: 'enforcement_before_consuming_preflight',
  }), true);
  let statusB = await workflow.getProjectWorkflowStatus({ projectRoot: projectB });
  const currentIndex = statusB.operationalMemory.lessons.findIndex(
    (item) => item.lessonCode === 'enforcement_before_consuming_preflight');
  const noisyGlobalIndex = statusB.operationalMemory.lessons.findIndex(
    (item) => item.lessonCode === 'shell_quoting_unreliable');
  assert.ok(currentIndex >= 0 && noisyGlobalIndex >= 0);
  assert.equal(statusB.operationalMemory.lessons[currentIndex].scope, 'workflow');
  assert.equal(statusB.operationalMemory.lessons[noisyGlobalIndex].scope, 'global');
  assert.ok(currentIndex < noisyGlobalIndex,
    'high-frequency global history must never outrank exact current-run memory');

  const linkedOnly = lesson(statusB, 'parallel_checkout_conflict');
  assert.ok(linkedOnly);
  assert.equal(linkedOnly.scope, 'global');
  assert.equal(linkedOnly.relevanceReason, 'global_recent',
    'linked worktrees of one stable project must count as one global project');

  await workflow.startProjectWorkflow({ projectRoot: projectC, goal: 'Distinct-project recurrence seed' });
  assert.equal(await workflow.recordOperationalLesson({
    projectRoot: projectC, lessonCode: 'parallel_checkout_conflict',
  }), true);
  await workflow.getProjectWorkflowStatus({ projectRoot: projectC });

  statusB = await workflow.getProjectWorkflowStatus({ projectRoot: projectB });
  const crossProjectRepeated = lesson(statusB, 'parallel_checkout_conflict');
  assert.ok(crossProjectRepeated);
  assert.equal(crossProjectRepeated.scope, 'global');
  assert.equal(crossProjectRepeated.relevanceReason, 'global_repeated',
    'the same safe lesson in two distinct projects should count as global recurrence');
  assert.ok(statusB.operationalMemory.lessons.length <= 8);

  console.log('PASS Operational Memory M3B safe global retrieval tests passed');
} finally {
  if (previousStateRoot === undefined) delete process.env.DESKTOP_COMMANDER_WORKFLOW_STATE_DIR;
  else process.env.DESKTOP_COMMANDER_WORKFLOW_STATE_DIR = previousStateRoot;
  await fs.rm(tempDir, { recursive: true, force: true });
}
