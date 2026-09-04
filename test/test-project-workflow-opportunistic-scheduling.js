/**
 * RED -> GREEN coverage for dependency-aware opportunistic workflow scheduling.
 */
import assert from 'node:assert';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import {
  getProjectWorkflowStatus,
  parseProjectWorkflowProfile,
  recordProjectWorkflowStage,
  startProjectWorkflow,
} from '../dist/workflow/project-workflow.js';
import { ProjectWorkflowArgsSchema } from '../dist/tools/schemas.js';

const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'dc-opportunistic-workflow-'));
const repo = path.join(tempDir, 'repo');
const stateRoot = path.join(tempDir, 'state');
const profileDir = path.join(repo, '.desktop-commander');
const profilePath = path.join(profileDir, 'project-workflow.json');

function git(...args) {
  return execFileSync('git', ['-C', repo, ...args], { encoding: 'utf8' }).trim();
}

try {
  process.env.DESKTOP_COMMANDER_WORKFLOW_STATE_DIR = stateRoot;
  await fs.mkdir(profileDir, { recursive: true });
  await fs.writeFile(profilePath, JSON.stringify({
    version: 1,
    id: 'opportunistic-test',
    name: 'Opportunistic workflow test',
    stages: [
      {
        id: 'inspect',
        label: 'Inspect',
        required: true,
        workMode: 'read_only'
      },
      {
        id: 'ci',
        label: 'CI',
        required: true,
        dependsOn: ['inspect']
      },
      {
        id: 'readiness-audit',
        label: 'Read-only readiness audit',
        required: true,
        dependsOn: ['inspect'],
        workMode: 'read_only',
        evidenceScope: 'git_head'
      },
      {
        id: 'mutating-followup',
        label: 'Mutating follow-up',
        required: false,
        dependsOn: ['inspect'],
        workMode: 'side_effecting'
      },
      {
        id: 'merge',
        label: 'Merge',
        required: true,
        dependsOn: ['ci', 'readiness-audit']
      }
    ]
  }, null, 2));

  execFileSync('git', ['init', repo]);
  git('config', 'user.email', 'test@example.invalid');
  git('config', 'user.name', 'Opportunistic Workflow Test');
  await fs.writeFile(path.join(repo, 'README.md'), '# Test\n');
  git('add', '.');
  git('commit', '-m', 'baseline');

  assert.throws(
    () => parseProjectWorkflowProfile({
      version: 1,
      id: 'bad-dependency',
      name: 'Bad dependency',
      stages: [
        { id: 'first', label: 'First', required: true, dependsOn: ['later'] },
        { id: 'later', label: 'Later', required: true }
      ]
    }),
    /dependency|dependsOn|earlier/i,
    'Dependencies must only point to earlier stages so cycles/forward waits are impossible'
  );

  const parsedWaiting = ProjectWorkflowArgsSchema.parse({
    action: 'record',
    projectRoot: repo,
    stageId: 'ci',
    status: 'waiting_external',
    reason: 'CI is still running'
  });
  assert.strictEqual(parsedWaiting.status, 'waiting_external');

  const started = await startProjectWorkflow({
    projectRoot: repo,
    goal: 'Use CI wait time for safe planned work'
  });
  assert.deepStrictEqual(started.readyStages.map((stage) => stage.id), ['inspect']);
  assert.deepStrictEqual(started.opportunisticStages.map((stage) => stage.id), ['inspect']);
  assert.strictEqual(started.nextStage?.id, 'inspect');
  assert.strictEqual(started.recommendedStage?.id, 'inspect');

  await recordProjectWorkflowStage({
    projectRoot: repo,
    stageId: 'inspect',
    status: 'completed',
    evidence: {
      kind: 'agent_attestation',
      summary: 'Repository inspected.'
    }
  });

  const blocked = await recordProjectWorkflowStage({
    projectRoot: repo,
    stageId: 'ci',
    status: 'blocked',
    reason: 'Requires human action'
  });
  assert.strictEqual(blocked.nextStage?.id, 'ci');
  assert.strictEqual(
    blocked.recommendedStage?.id,
    'ci',
    'A true blocker must not be skipped just because other work is available'
  );

  const waiting = await recordProjectWorkflowStage({
    projectRoot: repo,
    stageId: 'ci',
    status: 'waiting_external',
    reason: 'CI is running independently'
  });
  assert.deepStrictEqual(waiting.waitingStages.map((stage) => stage.id), ['ci']);
  assert.deepStrictEqual(
    waiting.readyStages.map((stage) => stage.id),
    ['readiness-audit', 'mutating-followup']
  );
  assert.deepStrictEqual(
    waiting.opportunisticStages.map((stage) => stage.id),
    ['readiness-audit'],
    'Only explicitly read-only ready work is safe to recommend opportunistically'
  );
  assert.strictEqual(waiting.nextStage?.id, 'ci');
  assert.strictEqual(
    waiting.recommendedStage?.id,
    'readiness-audit',
    'While CI waits, recommend the independent read-only stage'
  );

  const audited = await recordProjectWorkflowStage({
    projectRoot: repo,
    stageId: 'readiness-audit',
    status: 'completed',
    evidence: {
      kind: 'agent_attestation',
      summary: 'Read-only readiness audit completed.'
    }
  });
  const auditStage = audited.stages.find((stage) => stage.id === 'readiness-audit');
  assert.strictEqual(auditStage?.evidenceStale, false);
  assert.match(auditStage?.evidence?.gitHead ?? '', /^[0-9a-f]{40}$/);
  assert.strictEqual(
    audited.recommendedStage?.id,
    'ci',
    'After useful side work is exhausted, return to the external dependency for re-check'
  );

  await fs.writeFile(path.join(repo, 'README.md'), '# Test\nnew head\n');
  git('add', 'README.md');
  git('commit', '-m', 'advance head');

  const stale = await getProjectWorkflowStatus({ projectRoot: repo });
  const staleAudit = stale.stages.find((stage) => stage.id === 'readiness-audit');
  assert.strictEqual(staleAudit?.evidenceStale, true);
  assert.ok(
    stale.readyStages.some((stage) => stage.id === 'readiness-audit'),
    'Git-head scoped stale evidence must become ready for refresh'
  );
  assert.strictEqual(stale.recommendedStage?.id, 'readiness-audit');

  const refreshed = await recordProjectWorkflowStage({
    projectRoot: repo,
    stageId: 'readiness-audit',
    status: 'completed',
    evidence: {
      kind: 'agent_attestation',
      summary: 'Read-only readiness audit refreshed for the new HEAD.'
    }
  });
  assert.strictEqual(
    refreshed.stages.find((stage) => stage.id === 'readiness-audit')?.evidenceStale,
    false
  );
  assert.strictEqual(refreshed.recommendedStage?.id, 'ci');

  const ciDone = await recordProjectWorkflowStage({
    projectRoot: repo,
    stageId: 'ci',
    status: 'completed',
    evidence: {
      kind: 'provider_reference',
      summary: 'CI completed successfully for the current branch.',
      reference: 'github-actions://run/123'
    }
  });
  assert.ok(ciDone.readyStages.some((stage) => stage.id === 'merge'));
  assert.ok(!ciDone.waitingStages.some((stage) => stage.id === 'ci'));

  const sequentialRepo = path.join(tempDir, 'sequential');
  const sequentialProfileDir = path.join(sequentialRepo, '.desktop-commander');
  await fs.mkdir(sequentialProfileDir, { recursive: true });
  await fs.writeFile(
    path.join(sequentialProfileDir, 'project-workflow.json'),
    JSON.stringify({
      version: 1,
      id: 'sequential-backcompat',
      name: 'Sequential compatibility',
      stages: [
        { id: 'one', label: 'One', required: true },
        { id: 'two', label: 'Two', required: true }
      ]
    }, null, 2)
  );
  execFileSync('git', ['init', sequentialRepo]);
  execFileSync('git', ['-C', sequentialRepo, 'config', 'user.email', 'test@example.invalid']);
  execFileSync('git', ['-C', sequentialRepo, 'config', 'user.name', 'Sequential Test']);
  execFileSync('git', ['-C', sequentialRepo, 'add', '.']);
  execFileSync('git', ['-C', sequentialRepo, 'commit', '-m', 'baseline']);
  const sequential = await startProjectWorkflow({
    projectRoot: sequentialRepo,
    goal: 'Preserve sequential defaults'
  });
  assert.deepStrictEqual(
    sequential.readyStages.map((stage) => stage.id),
    ['one'],
    'Profiles without dependsOn must remain sequential by default'
  );

  console.log('✅ Opportunistic project workflow scheduling tests passed');
} finally {
  delete process.env.DESKTOP_COMMANDER_WORKFLOW_STATE_DIR;
  await fs.rm(tempDir, { recursive: true, force: true });
}
