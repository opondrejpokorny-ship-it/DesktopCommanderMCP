/**
 * RED -> GREEN test for the local, non-MCP access-control CLI.
 *
 * Human approval must live outside the MCP tool surface so an AI cannot approve
 * its own pending request.
 */

import assert from 'node:assert';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  createPendingApproval,
  listApprovals,
} from '../dist/policy/approval-store.js';
import { listAuditEvents } from '../dist/policy/audit-store.js';
import {
  listCommandPermissions,
  listFolderPermissions,
  loadPolicyRuntimeConfig,
} from '../dist/policy/policy-runtime.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const PROJECT_ROOT = path.resolve(__dirname, '..');
const CLI = path.join(PROJECT_ROOT, 'dist', 'npm-scripts', 'access-control.js');

const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'dc-access-cli-'));
const approvalFile = path.join(tempDir, 'approvals.json');
const auditFile = path.join(tempDir, 'audit.jsonl');
const policyFile = path.join(tempDir, 'policy.json');
const usageFile = path.join(tempDir, 'usage.json');

function runCli(...args) {
  return spawnSync(process.execPath, [CLI, ...args], {
    cwd: PROJECT_ROOT,
    encoding: 'utf8',
    env: {
      ...process.env,
      DESKTOP_COMMANDER_APPROVAL_FILE: approvalFile,
      DESKTOP_COMMANDER_AUDIT_FILE: auditFile,
      DESKTOP_COMMANDER_POLICY_FILE: policyFile,
      DESKTOP_COMMANDER_USAGE_FILE: usageFile,
    },
  });
}

try {
  await fs.writeFile(policyFile, JSON.stringify({
    version: 1,
    tier: 'team',
    profile: 'safe_developer',
    deviceId: 'server-1',
    rules: [],
  }));

  const pending = await createPendingApproval({
    tool: 'write_file',
    args: { path: '/projects/app.ts', content: 'change' },
    ruleId: 'team-write',
    resource: '/projects/app.ts',
    action: 'filesystem.write',
    deviceId: 'server-1',
    auditRequestId: 'audit-request-cli-1',
  }, approvalFile);

  const listResult = runCli('approvals');
  assert.strictEqual(listResult.status, 0, listResult.stderr);
  const listed = JSON.parse(listResult.stdout);
  assert.ok(Array.isArray(listed));
  assert.strictEqual(listed[0].id, pending.id);
  assert.strictEqual(listed[0].status, 'pending');
  assert.ok(!listResult.stdout.includes('change'), 'CLI must not expose raw file contents');

  const approveResult = runCli('approve', pending.id);
  assert.strictEqual(approveResult.status, 0, approveResult.stderr);
  const approved = JSON.parse(approveResult.stdout);
  assert.strictEqual(approved.id, pending.id);
  assert.strictEqual(approved.status, 'approved');

  const stored = await listApprovals(approvalFile);
  assert.strictEqual(stored[0].status, 'approved');

  const audit = await listAuditEvents(auditFile);
  assert.strictEqual(audit.length, 1);
  assert.strictEqual(audit[0].type, 'approval_decision');
  assert.strictEqual(audit[0].approvalDecision, 'approved');

  const policyResult = runCli('policy');
  assert.strictEqual(policyResult.status, 0, policyResult.stderr);
  const policy = JSON.parse(policyResult.stdout);
  assert.strictEqual(policy.tier, 'team');
  assert.strictEqual(policy.profile, 'safe_developer');
  assert.strictEqual(policy.deviceId, 'server-1');

  const tierResult = runCli('set-tier', 'pro');
  assert.strictEqual(tierResult.status, 0, tierResult.stderr);
  assert.strictEqual(JSON.parse(tierResult.stdout).tier, 'pro');

  const profileResult = runCli('set-profile', 'read_only');
  assert.strictEqual(profileResult.status, 0, profileResult.stderr);
  assert.strictEqual(JSON.parse(profileResult.stdout).profile, 'read_only');

  const deviceResult = runCli('set-device', 'device-from-control-center');
  assert.strictEqual(deviceResult.status, 0, deviceResult.stderr);
  assert.strictEqual(
    JSON.parse(deviceResult.stdout).deviceId,
    'device-from-control-center'
  );

  const folderResult = runCli(
    'set-folder',
    'approval_required',
    '/projects/production',
    'device-from-control-center'
  );
  assert.strictEqual(folderResult.status, 0, folderResult.stderr);

  const commandResult = runCli(
    'set-command',
    'approval_required',
    'git push',
    'device-from-control-center'
  );
  assert.strictEqual(commandResult.status, 0, commandResult.stderr);

  const updatedPolicy = await loadPolicyRuntimeConfig(policyFile);
  assert.strictEqual(updatedPolicy.tier, 'pro');
  assert.strictEqual(updatedPolicy.profile, 'read_only');
  assert.strictEqual(updatedPolicy.deviceId, 'device-from-control-center');

  assert.deepStrictEqual(listFolderPermissions(updatedPolicy), [{
    path: '/projects/production',
    permission: 'approval_required',
    deviceId: 'device-from-control-center',
  }]);

  assert.deepStrictEqual(listCommandPermissions(updatedPolicy), [{
    commandPrefix: 'git push',
    permission: 'approval_required',
    deviceId: 'device-from-control-center',
  }]);

  const invalidTier = runCli('set-tier', 'enterprise');
  assert.notStrictEqual(invalidTier.status, 0);
  assert.match(invalidTier.stderr, /invalid.*tier/i);

  const usageResult = runCli('usage');
  assert.strictEqual(usageResult.status, 0, usageResult.stderr);
  assert.deepStrictEqual(JSON.parse(usageResult.stdout), {
    returnedBytes: 0,
    writtenBytes: 0,
    periodStartedAt: null,
  });

  const stateResult = runCli('state');
  assert.strictEqual(stateResult.status, 0, stateResult.stderr);
  const state = JSON.parse(stateResult.stdout);
  assert.strictEqual(state.policy.tier, 'pro');
  assert.deepStrictEqual(state.folderPermissions, [{
    path: '/projects/production',
    permission: 'approval_required',
    deviceId: 'device-from-control-center',
  }]);
  assert.deepStrictEqual(state.commandPermissions, [{
    commandPrefix: 'git push',
    permission: 'approval_required',
    deviceId: 'device-from-control-center',
  }]);
  assert.ok(Array.isArray(state.pendingApprovals));
  assert.ok(Array.isArray(state.auditEvents));
  assert.deepStrictEqual(state.usage, {
    returnedBytes: 0,
    writtenBytes: 0,
    periodStartedAt: null,
  });

  const missingResult = runCli('approve', 'not-a-real-request-id');
  assert.notStrictEqual(missingResult.status, 0);
  assert.match(missingResult.stderr, /not found|not pending/i);

  console.log('✅ Local access-control CLI tests passed');
} finally {
  await fs.rm(tempDir, { recursive: true, force: true });
}
