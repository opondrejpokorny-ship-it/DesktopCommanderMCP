// RED -> GREEN coverage for low-overhead workflow progress enforcement.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  MIN_PROGRESS_REPORT_INTERVAL_MS,
  MAX_PROGRESS_REPORT_INTERVAL_MS,
  evaluateProgressReportingRequirement,
  getProjectWorkflowProgressRequirementForResolvedRoot,
  recordProjectWorkflowProgressReport,
  recordProjectWorkflowStage,
  startProjectWorkflow,
} from '../dist/workflow/project-workflow.js';
import { applyProgressEnforcementGate } from '../dist/workflow/progress-enforcement.js';
import { resolveWorkflowStatePath } from '../dist/workflow/workflow-storage.js';
import { registerActiveWork } from '../dist/workflow/active-work-registry.js';
import {
  configureRuntimeServices,
  resetRuntimeServicesForTests,
} from '../dist/runtime/runtime-services.js';
import { server } from '../dist/server.js';

const minute = 60_000;
assert.equal(MIN_PROGRESS_REPORT_INTERVAL_MS, 5 * minute);
assert.equal(MAX_PROGRESS_REPORT_INTERVAL_MS, 15 * minute);
const epoch = Date.parse('2026-09-06T12:00:00.000Z');
const fresh = { lastReportedAt: new Date(epoch).toISOString() };

assert.equal(
  evaluateProgressReportingRequirement(fresh, epoch + 14 * minute + 59_000).required,
  false,
);
const intervalDue = evaluateProgressReportingRequirement(fresh, epoch + 15 * minute);
assert.equal(intervalDue.required, true);
assert.equal(intervalDue.reason, 'interval');

const completedMilestone = {
  ...fresh,
  pendingMilestone: {
    stageId: 'implement',
    status: 'completed',
    since: new Date(epoch + 2 * minute).toISOString(),
  },
};
assert.equal(
  evaluateProgressReportingRequirement(
    completedMilestone,
    epoch + 4 * minute + 59_000,
  ).required,
  false,
);
const milestoneDue = evaluateProgressReportingRequirement(
  completedMilestone,
  epoch + 5 * minute,
);
assert.equal(milestoneDue.required, true);
assert.equal(milestoneDue.reason, 'milestone');

const waitingMilestone = {
  ...fresh,
  pendingMilestone: {
    stageId: 'ci',
    status: 'waiting_external',
    since: new Date(epoch + 2 * minute).toISOString(),
  },
};
const waitingDue = evaluateProgressReportingRequirement(
  waitingMilestone,
  epoch + 2 * minute,
);
assert.equal(waitingDue.required, true);
assert.equal(waitingDue.reason, 'milestone');

const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'dc-progress-enforcement-'));
const repo = path.join(tempDir, 'repo');
const stateRoot = path.join(tempDir, 'state');

function git(...args) {
  return execFileSync('git', ['-C', repo, ...args], { encoding: 'utf8' }).trim();
}

try {
  process.env.DESKTOP_COMMANDER_WORKFLOW_STATE_DIR = stateRoot;
  await fs.mkdir(path.join(repo, '.desktop-commander'), { recursive: true });
  await fs.writeFile(
    path.join(repo, '.desktop-commander', 'project-workflow.json'),
    JSON.stringify({
      version: 1,
      id: 'progress-enforcement-test',
      name: 'Progress enforcement test',
      stages: [
        { id: 'implement', label: 'Implement', required: true },
        { id: 'verify', label: 'Verify', required: true },
      ],
    }, null, 2),
  );
  execFileSync('git', ['init', repo]);
  git('config', 'user.email', 'test@example.invalid');
  git('config', 'user.name', 'Progress Enforcement Test');
  await fs.writeFile(path.join(repo, 'README.md'), '# Test\n');
  git('add', '.');
  git('commit', '-m', 'baseline');

  const started = await startProjectWorkflow({
    projectRoot: repo,
    goal: 'Prove progress enforcement',
  });
  assert.equal(started.progressReporting.required, false);
  assert.equal(started.progressReporting.pendingMilestone, undefined);

  const afterMilestone = await recordProjectWorkflowStage({
    projectRoot: repo,
    stageId: 'implement',
    status: 'completed',
    evidence: {
      kind: 'agent_attestation',
      summary: 'Implementation finished in test',
    },
  });
  assert.equal(afterMilestone.progress.percentRemaining, 50);
  assert.equal(afterMilestone.progressReporting.pendingMilestone?.stageId, 'implement');

  const afterReport = await recordProjectWorkflowProgressReport({ projectRoot: repo });
  assert.equal(afterReport.progress.percentRemaining, 50);
  assert.equal(afterReport.progressReporting.required, false);
  assert.equal(afterReport.progressReporting.pendingMilestone, undefined);

  const statePath = resolveWorkflowStatePath(repo);
  const rawState = JSON.parse(await fs.readFile(statePath, 'utf8'));
  rawState.progressReporting.lastReportedAt =
    new Date(Date.now() - MAX_PROGRESS_REPORT_INTERVAL_MS - minute).toISOString();
  await fs.writeFile(statePath, JSON.stringify(rawState, null, 2));

  const overdue = await getProjectWorkflowProgressRequirementForResolvedRoot(repo);
  assert.equal(overdue?.required, true);
  assert.equal(overdue?.reason, 'interval');

  const readGate = await applyProgressEnforcementGate(
    'read_file',
    { path: path.join(repo, 'README.md') },
    { projectRoots: [repo] },
  );
  assert.equal(readGate.allowed, true);

  const writeGate = await applyProgressEnforcementGate(
    'write_file',
    { path: path.join(repo, 'next.txt'), content: 'x' },
    { projectRoots: [repo] },
  );
  assert.equal(writeGate.allowed, false);
  assert.equal(writeGate.result?.structuredContent?.code, 'PROGRESS_REPORT_REQUIRED');
  assert.equal(writeGate.result?.structuredContent?.requiredTool, 'report_task_progress');

  await recordProjectWorkflowProgressReport({ projectRoot: repo });
  const writeAfterReport = await applyProgressEnforcementGate(
    'write_file',
    { path: path.join(repo, 'next.txt'), content: 'x' },
    { projectRoots: [repo] },
  );
  assert.equal(writeAfterReport.allowed, true);

  const integrationState = JSON.parse(await fs.readFile(statePath, 'utf8'));
  integrationState.progressReporting.lastReportedAt =
    new Date(Date.now() - MAX_PROGRESS_REPORT_INTERVAL_MS - minute).toISOString();
  await fs.writeFile(statePath, JSON.stringify(integrationState, null, 2));
  const active = await registerActiveWork({
    projectRoot: repo,
    title: 'Progress enforcement integration',
    scope: 'Verify progress blocks before policy preflight',
    affectedAreas: ['.'],
  });
  assert.equal(active.registered, true);
  let policyPreflightCalls = 0;
  configureRuntimeServices({
    policyHook: {
      async preflight() {
        policyPreflightCalls += 1;
        return { allowed: true, decision: 'allow' };
      },
    },
  });
  const callToolHandler = server._requestHandlers.get('tools/call');
  assert.ok(callToolHandler, 'tools/call handler must exist');
  const blockedWritePath = path.join(repo, 'must-not-write.txt');
  const blockedWrite = await callToolHandler({
    method: 'tools/call',
    params: {
      name: 'write_file',
      arguments: { path: blockedWritePath, content: 'must not execute' },
    },
  }, {});
  assert.equal(blockedWrite.structuredContent?.code, 'PROGRESS_REPORT_REQUIRED');
  assert.equal(policyPreflightCalls, 0, 'progress block must not consume policy approval');
  await assert.rejects(fs.access(blockedWritePath));
  resetRuntimeServicesForTests();
  const corruptState = JSON.parse(await fs.readFile(statePath, 'utf8'));
  corruptState.progressReporting.lastReportedAt = 'not-a-timestamp';
  await fs.writeFile(statePath, JSON.stringify(corruptState, null, 2));
  const corruptWriteGate = await applyProgressEnforcementGate(
    'write_file',
    { path: path.join(repo, 'corrupt.txt'), content: 'must not execute' },
    { projectRoots: [repo] },
  );
  assert.equal(corruptWriteGate.allowed, false);
  assert.equal(corruptWriteGate.result?.structuredContent?.code, 'PROGRESS_REPORT_CHECK_FAILED');
  const corruptWorkflowGate = await applyProgressEnforcementGate(
    'project_workflow',
    { action: 'record', projectRoot: repo, stageId: 'verify', status: 'completed' },
  );
  assert.equal(corruptWorkflowGate.allowed, false);
  assert.equal(corruptWorkflowGate.result?.structuredContent?.code, 'PROGRESS_REPORT_CHECK_FAILED');
  const serverSource = await fs.readFile(new URL('../src/server.ts', import.meta.url), 'utf8');
  const progressGateCall = serverSource.indexOf(
    'const progressGate = await applyProgressEnforcementGate',
  );
  const policyPreflightCall = serverSource.indexOf('runtimePolicyHook.preflight(');
  assert.ok(progressGateCall >= 0, 'server must invoke progress enforcement');
  assert.ok(policyPreflightCall >= 0, 'server policy preflight must exist');
  assert.ok(
    progressGateCall < policyPreflightCall,
    'progress enforcement must run before policy preflight can consume approval',
  );
  assert.match(
    serverSource,
    /recordProjectWorkflowProgressReport/,
    'workflow-mode report_task_progress must record the authoritative report',
  );
  console.log('âś… Progress enforcement tests passed');
} finally {
  delete process.env.DESKTOP_COMMANDER_WORKFLOW_STATE_DIR;
  await fs.rm(tempDir, { recursive: true, force: true });
}