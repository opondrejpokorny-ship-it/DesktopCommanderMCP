/**
 * RED -> GREEN integration test for the local web Control Center.
 */

import assert from 'node:assert';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  createPendingApproval,
  listApprovals,
} from '../dist/policy/approval-store.js';
import { listAuditEvents } from '../dist/policy/audit-store.js';
import { startControlCenter } from '../dist/control-center/server.js';

const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'dc-control-center-'));
const approvalFile = path.join(tempDir, 'approvals.json');
const auditFile = path.join(tempDir, 'audit.jsonl');
const policyFile = path.join(tempDir, 'policy.json');
const remoteDeviceFile = path.join(tempDir, 'device.json');

const previousEnv = {
  approval: process.env.DESKTOP_COMMANDER_APPROVAL_FILE,
  audit: process.env.DESKTOP_COMMANDER_AUDIT_FILE,
  policy: process.env.DESKTOP_COMMANDER_POLICY_FILE,
  remoteDevice: process.env.DESKTOP_COMMANDER_REMOTE_DEVICE_CONFIG_FILE,
};

process.env.DESKTOP_COMMANDER_APPROVAL_FILE = approvalFile;
process.env.DESKTOP_COMMANDER_AUDIT_FILE = auditFile;
process.env.DESKTOP_COMMANDER_POLICY_FILE = policyFile;
process.env.DESKTOP_COMMANDER_REMOTE_DEVICE_CONFIG_FILE = remoteDeviceFile;

let controlCenter;

try {
  await fs.writeFile(policyFile, JSON.stringify({
    version: 1,
    tier: 'team',
    profile: 'safe_developer',
    deviceId: 'server-1',
    rules: [],
  }));

  await fs.writeFile(remoteDeviceFile, JSON.stringify({
    deviceId: 'remote-device-1',
    session: {
      access_token: 'control-center-must-not-expose-this',
      refresh_token: 'or-this',
    },
  }));


  const pending = await createPendingApproval({
    tool: 'write_file',
    args: { path: '/projects/app.ts', content: 'private-change' },
    ruleId: 'team-write',
    resource: '/projects/app.ts',
    action: 'filesystem.write',
    deviceId: 'server-1',
    auditRequestId: 'control-center-audit-1',
  });

  controlCenter = await startControlCenter({
    host: '127.0.0.1',
    port: 0,
    token: 'test-control-token',
    quiet: true,
  });

  assert.strictEqual(controlCenter.host, '127.0.0.1');
  assert.ok(controlCenter.port > 0);

  const home = await fetch(controlCenter.url);
  assert.strictEqual(home.status, 200);
  assert.match(await home.text(), /Desktop Commander Control Center/i);
  assert.strictEqual(home.headers.get('cache-control'), 'no-store');
  assert.match(home.headers.get('content-security-policy') ?? '', /frame-ancestors 'none'/);

  const forbidden = await fetch(`${controlCenter.url}api/state`);
  assert.strictEqual(forbidden.status, 403, 'API should require the local session token');

  const stateResponse = await fetch(`${controlCenter.url}api/state`, {
    headers: { 'X-DC-Control-Token': 'test-control-token' },
  });
  assert.strictEqual(stateResponse.status, 200);
  const state = await stateResponse.json();
  assert.strictEqual(state.policy.tier, 'team');
  assert.strictEqual(state.policy.profile, 'safe_developer');
  assert.deepStrictEqual(state.detectedDeviceIdentity, {
    deviceId: 'remote-device-1',
  });
  assert.ok(
    !JSON.stringify(state).includes('control-center-must-not-expose-this'),
    'Control Center state must not expose Remote Device auth tokens'
  );
  assert.strictEqual(state.pendingApprovals.length, 1);
  assert.strictEqual(state.pendingApprovals[0].id, pending.id);
  assert.ok(
    !JSON.stringify(state).includes('private-change'),
    'Control Center API must not expose raw MCP file contents'
  );

  const deniedWithoutToken = await fetch(
    `${controlCenter.url}api/approvals/${pending.id}/approve`,
    { method: 'POST' }
  );
  assert.strictEqual(deniedWithoutToken.status, 403);

  const approveResponse = await fetch(
    `${controlCenter.url}api/approvals/${pending.id}/approve`,
    {
      method: 'POST',
      headers: { 'X-DC-Control-Token': 'test-control-token' },
    }
  );
  assert.strictEqual(approveResponse.status, 200);
  const approved = await approveResponse.json();
  assert.strictEqual(approved.status, 'approved');

  const profileResponse = await fetch(
    `${controlCenter.url}api/policy/profile/read_only`,
    {
      method: 'POST',
      headers: { 'X-DC-Control-Token': 'test-control-token' },
    }
  );
  assert.strictEqual(profileResponse.status, 200);
  const updatedProfile = await profileResponse.json();
  assert.strictEqual(updatedProfile.profile, 'read_only');

  const tierResponse = await fetch(
    `${controlCenter.url}api/policy/tier/pro`,
    {
      method: 'POST',
      headers: { 'X-DC-Control-Token': 'test-control-token' },
    }
  );
  assert.strictEqual(tierResponse.status, 200);
  const updatedTier = await tierResponse.json();
  assert.strictEqual(updatedTier.tier, 'pro');

  const invalidProfile = await fetch(
    `${controlCenter.url}api/policy/profile/not-a-real-profile`,
    {
      method: 'POST',
      headers: { 'X-DC-Control-Token': 'test-control-token' },
    }
  );
  assert.strictEqual(invalidProfile.status, 400);

  const folderResponse = await fetch(
    `${controlCenter.url}api/policy/folders`,
    {
      method: 'POST',
      headers: {
        'X-DC-Control-Token': 'test-control-token',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        path: tempDir,
        permission: 'read_only',
      }),
    }
  );
  assert.strictEqual(folderResponse.status, 200);
  const folderState = await folderResponse.json();
  assert.strictEqual(folderState.folderPermissions.length, 1);
  assert.strictEqual(folderState.folderPermissions[0].path, tempDir);
  assert.strictEqual(folderState.folderPermissions[0].permission, 'read_only');

  const invalidFolder = await fetch(
    `${controlCenter.url}api/policy/folders`,
    {
      method: 'POST',
      headers: {
        'X-DC-Control-Token': 'test-control-token',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        path: 'relative/not-allowed',
        permission: 'blocked',
      }),
    }
  );
  assert.strictEqual(invalidFolder.status, 400);

  const commandResponse = await fetch(
    `${controlCenter.url}api/policy/commands`,
    {
      method: 'POST',
      headers: {
        'X-DC-Control-Token': 'test-control-token',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        commandPrefix: 'git push',
        permission: 'approval_required',
      }),
    }
  );
  assert.strictEqual(commandResponse.status, 200);
  const commandState = await commandResponse.json();
  assert.deepStrictEqual(commandState.commandPermissions, [{
    commandPrefix: 'git push',
    permission: 'approval_required',
  }]);

  const invalidCommand = await fetch(
    `${controlCenter.url}api/policy/commands`,
    {
      method: 'POST',
      headers: {
        'X-DC-Control-Token': 'test-control-token',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        commandPrefix: '',
        permission: 'blocked',
      }),
    }
  );
  assert.strictEqual(invalidCommand.status, 400);

  const stateAfterFolder = await fetch(`${controlCenter.url}api/state`, {
    headers: { 'X-DC-Control-Token': 'test-control-token' },
  }).then((response) => response.json());
  assert.strictEqual(stateAfterFolder.folderPermissions.length, 1);
  assert.strictEqual(stateAfterFolder.folderPermissions[0].permission, 'read_only');

  const deviceResponse = await fetch(
    `${controlCenter.url}api/policy/device`,
    {
      method: 'POST',
      headers: {
        'X-DC-Control-Token': 'test-control-token',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ deviceId: 'remote-device-1' }),
    }
  );
  assert.strictEqual(deviceResponse.status, 200);
  const updatedDevice = await deviceResponse.json();
  assert.strictEqual(updatedDevice.deviceId, 'remote-device-1');

  const persistedPolicy = JSON.parse(await fs.readFile(policyFile, 'utf8'));
  assert.strictEqual(persistedPolicy.profile, 'read_only');
  assert.strictEqual(persistedPolicy.tier, 'pro');
  assert.strictEqual(persistedPolicy.deviceId, 'remote-device-1');

  const approvals = await listApprovals();
  assert.strictEqual(approvals[0].status, 'approved');

  const audit = await listAuditEvents();
  assert.strictEqual(audit.length, 1);
  assert.strictEqual(audit[0].type, 'approval_decision');
  assert.strictEqual(audit[0].approvalDecision, 'approved');

  console.log('✅ Local web Control Center tests passed');
} finally {
  if (controlCenter) {
    await controlCenter.close();
  }

  if (previousEnv.approval === undefined) {
    delete process.env.DESKTOP_COMMANDER_APPROVAL_FILE;
  } else {
    process.env.DESKTOP_COMMANDER_APPROVAL_FILE = previousEnv.approval;
  }
  if (previousEnv.audit === undefined) {
    delete process.env.DESKTOP_COMMANDER_AUDIT_FILE;
  } else {
    process.env.DESKTOP_COMMANDER_AUDIT_FILE = previousEnv.audit;
  }
  if (previousEnv.policy === undefined) {
    delete process.env.DESKTOP_COMMANDER_POLICY_FILE;
  } else {
    process.env.DESKTOP_COMMANDER_POLICY_FILE = previousEnv.policy;
  }
  if (previousEnv.remoteDevice === undefined) {
    delete process.env.DESKTOP_COMMANDER_REMOTE_DEVICE_CONFIG_FILE;
  } else {
    process.env.DESKTOP_COMMANDER_REMOTE_DEVICE_CONFIG_FILE = previousEnv.remoteDevice;
  }

  await fs.rm(tempDir, { recursive: true, force: true });
}
