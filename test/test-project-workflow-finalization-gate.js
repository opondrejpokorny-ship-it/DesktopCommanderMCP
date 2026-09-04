/**
 * RED -> GREEN coverage for persistent workflow finalization gates.
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
  resumeProjectWorkflow,
  startProjectWorkflow,
} from '../dist/workflow/project-workflow.js';

const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'dc-finalization-gate-'));
const repo = path.join(tempDir, 'repo');
const stateRoot = path.join(tempDir, 'state');
const profileDir = path.join(repo, '.desktop-commander');

function git(...args) {
  return execFileSync('git', ['-C', repo, ...args], { encoding: 'utf8' }).trim();
}

const evidence = (summary) => ({ kind: 'provider_reference', summary, reference: 'ci://proof' });

try {
  process.env.DESKTOP_COMMANDER_WORKFLOW_STATE_DIR = stateRoot;
  await fs.mkdir(profileDir, { recursive: true });
  await fs.writeFile(path.join(profileDir, 'project-workflow.json'), JSON.stringify({
    version: 1,
    id: 'finalization-gate-test',
    name: 'Finalization gate test',
    stages: [
      { id: 'integration', label: 'Integrate', required: true },
      { id: 'verify-sha', label: 'Verify merged SHA', required: true, dependsOn: ['integration'], evidenceScope: 'git_head' },
      { id: 'post-merge-ci', label: 'Post-merge CI', required: true, dependsOn: ['verify-sha'], evidenceScope: 'git_head', workMode: 'read_only' },
      { id: 'docs-sync', label: 'Docs sync', required: true, dependsOn: ['post-merge-ci'] },
      { id: 'registry-cleanup', label: 'Registry cleanup', required: true, dependsOn: ['docs-sync'] },
      { id: 'final-report', label: 'Final report', required: true, dependsOn: ['registry-cleanup'] },
    ],
  }, null, 2));

  execFileSync('git', ['init', repo]);
  git('config', 'user.email', 'test@example.invalid');
  git('config', 'user.name', 'Finalization Gate Test');
  await fs.writeFile(path.join(repo, 'README.md'), '# finalization\n');
  git('add', '.');
  git('commit', '-m', 'baseline');

  await startProjectWorkflow({ projectRoot: repo, goal: 'Finish only after post-merge evidence and cleanup' });
  await recordProjectWorkflowStage({ projectRoot: repo, stageId: 'integration', status: 'completed', evidence: evidence('Merged.') });
  await recordProjectWorkflowStage({ projectRoot: repo, stageId: 'verify-sha', status: 'completed', evidence: evidence('Merged SHA verified.') });

  const waiting = await recordProjectWorkflowStage({
    projectRoot: repo,
    stageId: 'post-merge-ci',
    status: 'waiting_external',
    reason: 'Merged-SHA CI still running',
  });
  assert.deepStrictEqual(waiting.waitingStages.map((stage) => stage.id), ['post-merge-ci']);
  assert.strictEqual(waiting.recommendedStage?.id, 'post-merge-ci');

  const resumed = await resumeProjectWorkflow({ projectRoot: repo });
  assert.strictEqual(resumed.recommendedStage?.id, 'post-merge-ci');
  await assert.rejects(
    () => recordProjectWorkflowStage({ projectRoot: repo, stageId: 'docs-sync', status: 'completed', evidence: evidence('Too early.') }),
    /depend|post-merge-ci|prerequisite/i,
  );
  await assert.rejects(() => finishProjectWorkflow({ projectRoot: repo }), /post-merge-ci|incomplete|waiting/i);

  await recordProjectWorkflowStage({ projectRoot: repo, stageId: 'post-merge-ci', status: 'completed', evidence: evidence('Merged-SHA CI passed.') });

  await fs.writeFile(path.join(repo, 'README.md'), '# finalization\nnew authoritative head\n');
  git('add', 'README.md');
  git('commit', '-m', 'advance authoritative head');

  const stale = await getProjectWorkflowStatus({ projectRoot: repo });
  assert.strictEqual(stale.stages.find((stage) => stage.id === 'verify-sha')?.evidenceStale, true);
  assert.strictEqual(stale.stages.find((stage) => stage.id === 'post-merge-ci')?.evidenceStale, true);
  await assert.rejects(
    () => recordProjectWorkflowStage({ projectRoot: repo, stageId: 'docs-sync', status: 'completed', evidence: evidence('Stale dependency.') }),
    /depend|stale|post-merge-ci|prerequisite/i,
  );
  await assert.rejects(() => finishProjectWorkflow({ projectRoot: repo }), /stale|verify-sha|post-merge-ci/i);

  await recordProjectWorkflowStage({ projectRoot: repo, stageId: 'verify-sha', status: 'completed', evidence: evidence('New merged SHA verified.') });
  await recordProjectWorkflowStage({ projectRoot: repo, stageId: 'post-merge-ci', status: 'completed', evidence: evidence('New merged-SHA CI passed.') });
  await recordProjectWorkflowStage({ projectRoot: repo, stageId: 'docs-sync', status: 'completed', evidence: evidence('Durable docs updated.') });
  await recordProjectWorkflowStage({ projectRoot: repo, stageId: 'registry-cleanup', status: 'completed', evidence: evidence('Registry entry removed.') });
  await recordProjectWorkflowStage({ projectRoot: repo, stageId: 'final-report', status: 'completed', evidence: evidence('Final report delivered.') });

  const finished = await finishProjectWorkflow({ projectRoot: repo });
  assert.strictEqual(finished.completed, true);
  assert.strictEqual(finished.progress.percentRemaining, 0);
  console.log('✅ Workflow finalization gate tests passed');
} finally {
  delete process.env.DESKTOP_COMMANDER_WORKFLOW_STATE_DIR;
  await fs.rm(tempDir, { recursive: true, force: true });
}
