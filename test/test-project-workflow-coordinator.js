/**
 * RED -> GREEN tests for the persistent project workflow coordinator.
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
import { applyPolicyGate } from '../dist/policy/policy-gate.js';

const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'dc-project-workflow-test-'));
const projectRoot = path.join(tempDir, 'repo');
const stateRoot = path.join(tempDir, 'state');
const profileDir = path.join(projectRoot, '.desktop-commander');
const profilePath = path.join(profileDir, 'project-workflow.json');
const projectProfilePath = path.join(profileDir, 'project-profile.json');
const approvalPath = path.join(tempDir, 'approvals.json');
const missingPolicy = path.join(tempDir, 'missing-policy.json');

function git(...args) {
  return execFileSync('git', ['-C', projectRoot, ...args], { encoding: 'utf8' }).trim();
}
try {
  process.env.DESKTOP_COMMANDER_WORKFLOW_STATE_DIR = stateRoot;
  await fs.mkdir(profileDir, { recursive: true });
  await fs.writeFile(profilePath, JSON.stringify({
    version: 1,
    id: 'test-project',
    name: 'Test project',
    definitionOfDone: 'All required stages verified.',
    stages: [
      { id: 'drive-pre-read', label: 'Drive pre-read', required: true },
      { id: 'repo-audit', label: 'Repo/upstream audit', required: true },
      { id: 'verification', label: 'Verification', required: true },
      {
        id: 'deploy',
        label: 'Deploy',
        required: false,
        authorizationRequired: true
      }
    ]
  }, null, 2));

  await fs.writeFile(projectProfilePath, JSON.stringify({
    version: 1,
    name: 'Coordinator Project Profile',
    instructions: ['Use the registered project workflow.'],
    definitionOfDone: 'Verified and integrated.',
    requiredPreRead: [{ label: 'Roadmap', uri: 'https://docs.example.invalid/roadmap' }],
    repository: {
      authoritativeRepository: 'example.invalid/upstream/repo',
      authoritativeBranch: 'main'
    },
    workflowProfile: '.desktop-commander/project-workflow.json',
    verificationRequirements: ['Run focused tests.'],
    deploymentRequirements: ['Deploy only with explicit authorization.'],
    graphify: { wrapper: 'scripts/graphify-local.cmd', mode: 'local_code_only' },
    documentation: [{ label: 'Playbook', uri: 'https://docs.example.invalid/playbook' }]
  }, null, 2));
  execFileSync('git', ['init', projectRoot]);
  git('config', 'user.email', 'test@example.invalid');
  git('config', 'user.name', 'Workflow Test');
  await fs.writeFile(path.join(projectRoot, 'README.md'), '# Test\n');
  git('add', '.');
  git('commit', '-m', 'baseline');
  git('remote', 'add', 'upstream', 'https://example.invalid/upstream/repo.git');

  const started = await startProjectWorkflow({
    projectRoot,
    goal: 'Implement a verified feature'
  });
  assert.strictEqual(started.profile.id, 'test-project');
  assert.match(started.projectIdentity.projectId, /^[a-f0-9]{24}$/);
  assert.match(started.projectIdentity.repository.repositoryId, /^[a-f0-9]{24}$/);
  assert.strictEqual(started.projectProfile.profile.name, 'Coordinator Project Profile');
  assert.strictEqual(
    started.projectProfile.identity.projectId,
    started.projectIdentity.projectId
  );
  assert.strictEqual(
    started.projectProfile.identity.repository.repositoryId,
    started.projectIdentity.repository.repositoryId
  );
  assert.strictEqual(started.goal, 'Implement a verified feature');
  assert.strictEqual(started.progress.percentComplete, 0);
  assert.strictEqual(started.nextStage?.id, 'drive-pre-read');
  assert.strictEqual(started.git.dirty, false);
  assert.match(started.git.head, /^[0-9a-f]{40}$/);
  assert.ok(started.git.branch.length > 0);
  assert.strictEqual(started.git.remotes.upstream, 'https://example.invalid/upstream/repo.git');

  const expectedStatePath = resolveWorkflowStatePath(projectRoot);
  assert.strictEqual(started.statePath, expectedStatePath);
  assert.ok(expectedStatePath.startsWith(path.resolve(stateRoot)));

  const stateGate = await applyPolicyGate(
    'write_file',
    { path: expectedStatePath, content: 'tamper' },
    missingPolicy,
    approvalPath
  );
  assert.strictEqual(stateGate.allowed, false);
  assert.strictEqual(stateGate.decision, 'deny');
  assert.strictEqual(stateGate.matchedRuleId, 'system:project-workflow-control-plane');

  const stateAliasDir = path.join(tempDir, 'state-alias');
  await fs.symlink(
    stateRoot,
    stateAliasDir,
    process.platform === 'win32' ? 'junction' : 'dir'
  );
  const symlinkStateGate = await applyPolicyGate(
    'write_file',
    {
      path: path.join(stateAliasDir, path.basename(expectedStatePath)),
      content: 'tamper through symlink alias'
    },
    missingPolicy,
    approvalPath
  );
  assert.strictEqual(symlinkStateGate.allowed, false,
    'Workflow state protection must canonicalize symlink aliases');
  assert.strictEqual(
    symlinkStateGate.matchedRuleId,
    'system:project-workflow-control-plane'
  );
  const profileGate = await applyPolicyGate(
    'write_file',
    { path: profilePath, content: 'tamper' },
    missingPolicy,
    approvalPath
  );
  assert.strictEqual(profileGate.allowed, false);
  assert.strictEqual(profileGate.matchedRuleId, 'system:project-workflow-control-plane');

  const boundaryGate = await applyPolicyGate(
    'write_file',
    { path: profilePath + '.bak', content: 'allowed boundary' },
    missingPolicy,
    approvalPath
  );
  assert.strictEqual(boundaryGate.allowed, true);

  const profileAliasDir = path.join(tempDir, 'profile-alias');
  await fs.symlink(profileDir, profileAliasDir, 'junction');
  const symlinkGate = await applyPolicyGate(
    'write_file',
    { path: path.join(profileAliasDir, 'project-workflow.json'), content: 'tamper' },
    missingPolicy,
    approvalPath
  );
  assert.strictEqual(symlinkGate.allowed, false);
  assert.strictEqual(symlinkGate.matchedRuleId, 'system:project-workflow-control-plane');
  const afterDrive = await recordProjectWorkflowStage({
    projectRoot,
    stageId: 'drive-pre-read',
    status: 'completed',
    evidence: {
      kind: 'provider_reference',
      summary: 'Roadmap read; accidental token ghp_super_secret_value must be redacted.',
      reference: 'gdrive://roadmap'
    }
  });
  assert.strictEqual(afterDrive.progress.completedStages, 1);
  assert.strictEqual(afterDrive.nextStage?.id, 'repo-audit');

  await assert.rejects(
    () => recordProjectWorkflowStage({
      projectRoot,
      stageId: 'deploy',
      status: 'completed',
      evidence: {
        kind: 'provider_reference',
        summary: 'Deployment looked ready.'
      }
    }),
    /authorization/i
  );

  await assert.rejects(
    () => recordProjectWorkflowStage({
      projectRoot,
      stageId: 'deploy',
      status: 'completed',
      evidence: {
        kind: 'user_authorization',
        summary: 'Agent claims that the user approved deployment.'
      }
    }),
    /trusted|self-attest|authorization/i
  );
  await fs.writeFile(path.join(projectRoot, 'scratch.txt'), 'dirty\n');
  const resumedDirty = await resumeProjectWorkflow({ projectRoot });
  assert.strictEqual(resumedDirty.git.dirty, true);
  await fs.rm(path.join(projectRoot, 'scratch.txt'));

  const afterAudit = await recordProjectWorkflowStage({
    projectRoot,
    stageId: 'repo-audit',
    status: 'completed',
    evidence: {
      kind: 'agent_attestation',
      summary: 'Branch, remotes and upstream state checked.'
    }
  });
  assert.strictEqual(afterAudit.nextStage?.id, 'verification');
  await assert.rejects(
    () => finishProjectWorkflow({ projectRoot }),
    /required stages/i
  );

  const originalProfileText = await fs.readFile(profilePath, 'utf8');
  await fs.writeFile(
    profilePath,
    originalProfileText.replace('Verification', 'Verification changed')
  );
  await assert.rejects(
    () => finishProjectWorkflow({ projectRoot }),
    /profile.*changed|fingerprint|drift/i
  );
  await fs.writeFile(profilePath, originalProfileText);

  await recordProjectWorkflowStage({
    projectRoot,
    stageId: 'verification',
    status: 'completed',
    evidence: {
      kind: 'agent_attestation',
      summary: 'Focused and integration verification passed.'
    }
  });

  const trustedDeploy = await recordProjectWorkflowStage(
    {
      projectRoot,
      stageId: 'deploy',
      status: 'completed',
      evidence: {
        kind: 'user_authorization',
        summary: 'User explicitly approved deployment through a trusted host path.'
      }
    },
    { trustedUserAuthorization: true }
  );
  const deployStage = trustedDeploy.stages.find((stage) => stage.id === 'deploy');
  assert.strictEqual(deployStage?.status, 'completed');
  assert.strictEqual(deployStage?.evidence?.kind, 'user_authorization');
  assert.strictEqual(deployStage?.evidence?.trust, 'trusted_host');

  const finished = await finishProjectWorkflow({ projectRoot });
  assert.strictEqual(finished.completed, true);
  assert.strictEqual(finished.progress.percentComplete, 100);
  assert.strictEqual(finished.nextStage, null);

  const status = await getProjectWorkflowStatus({ projectRoot });
  assert.strictEqual(status.completed, true);
  assert.strictEqual(status.progress.percentComplete, 100);
  const persistedText = await fs.readFile(expectedStatePath, 'utf8');
  assert.ok(!persistedText.includes('ghp_super_secret_value'));
  assert.match(persistedText, /\[REDACTED\]/);
  assert.ok(!persistedText.includes('rawCommand'));
  assert.ok(!persistedText.includes('fileContents'));
  assert.ok(!persistedText.includes('projectIdentity'));
  assert.ok(!persistedText.includes('projectProfile'));
  assert.ok(!persistedText.includes('Coordinator Project Profile'));

  console.log('✅ Project workflow coordinator tests passed');
} finally {
  delete process.env.DESKTOP_COMMANDER_WORKFLOW_STATE_DIR;
  await fs.rm(tempDir, { recursive: true, force: true });
}
