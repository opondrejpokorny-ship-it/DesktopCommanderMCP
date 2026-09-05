/**
 * Integration coverage for the recomposed prototype Control Center.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createPendingApproval, listApprovals } from '../dist/policy/approval-store.js';
import { listAuditEvents } from '../dist/policy/audit-store.js';
import { startControlCenter } from '../dist/control-center/server.js';

const PRIVATE_FILE = 'private-change';
const PRIVATE_ACCESS = 'control-center-must-not-expose-this';
const PRIVATE_REFRESH = 'or-this';
const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'dc-control-center-'));
const approvalFile = path.join(tempDir, 'approvals.json');
const auditFile = path.join(tempDir, 'audit.jsonl');
const policyFile = path.join(tempDir, 'policy.json');
const remoteDeviceFile = path.join(tempDir, 'device.json');
const envKeys = [
  'DESKTOP_COMMANDER_APPROVAL_FILE',
  'DESKTOP_COMMANDER_AUDIT_FILE',
  'DESKTOP_COMMANDER_POLICY_FILE',
  'DESKTOP_COMMANDER_REMOTE_DEVICE_CONFIG_FILE',
];
const oldEnv = Object.fromEntries(envKeys.map((key) => [key, process.env[key]]));
process.env.DESKTOP_COMMANDER_APPROVAL_FILE = approvalFile;
process.env.DESKTOP_COMMANDER_AUDIT_FILE = auditFile;
process.env.DESKTOP_COMMANDER_POLICY_FILE = policyFile;
process.env.DESKTOP_COMMANDER_REMOTE_DEVICE_CONFIG_FILE = remoteDeviceFile;

function assertPrivateMarkersAbsent(value) {
  const serialized = JSON.stringify(value);
  for (const marker of [PRIVATE_FILE, PRIVATE_ACCESS, PRIVATE_REFRESH]) {
    assert.ok(!serialized.includes(marker), `Control Center leaked ${marker}`);
  }
}
async function api(running, pathname, { method = 'GET', body, token = running.token } = {}) {
  const headers = { 'X-DC-Control-Token': token };
  if (method !== 'GET') {
    headers.Origin = new URL(running.url).origin;
    if (body !== undefined) headers['Content-Type'] = 'application/json';
  }
  const response = await fetch(new URL(pathname, running.url), {
    method,
    headers,
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const text = await response.text();
  return { response, text, json: text ? JSON.parse(text) : null };
}

let controlCenter;
try {
  await fs.writeFile(policyFile, JSON.stringify({
    version: 1,
    tier: 'team',
    profile: 'safe_developer',
    deviceId: 'server-1',
    rules: [],
  }), 'utf8');
  await fs.writeFile(remoteDeviceFile, JSON.stringify({
    deviceId: 'remote-device-1',
    session: { access_token: PRIVATE_ACCESS, refresh_token: PRIVATE_REFRESH },
  }), 'utf8');

  const pending = await createPendingApproval({
    tool: 'write_file',
    args: { path: '/projects/app.ts', content: PRIVATE_FILE },
    ruleId: 'team-write',
    resource: '/projects/app.ts',
    action: 'filesystem.write',
    deviceId: 'server-1',
    auditRequestId: 'control-center-audit-1',
  });
  controlCenter = await startControlCenter({
    host: '127.0.0.1', port: 0, token: 'test-control-token', quiet: true,
  });

  assert.strictEqual(controlCenter.host, '127.0.0.1');
  assert.ok(controlCenter.port > 0);
  const home = await fetch(controlCenter.url);
  assert.strictEqual(home.status, 200);
  assert.match(await home.text(), /Desktop Commander Control Center/i);
  assert.strictEqual(home.headers.get('cache-control'), 'no-store');
  assert.match(home.headers.get('content-security-policy') ?? '', /frame-ancestors 'none'/);

  const forbidden = await fetch(new URL('/api/state', controlCenter.url));
  assert.strictEqual(forbidden.status, 403, 'API should require the local session token');
  const neutral = await api(controlCenter, '/api/state');
  assert.strictEqual(neutral.response.status, 200);
  assert.strictEqual(neutral.json.entitlement.tier, 'team');
  assert.deepStrictEqual(
    neutral.json.activeExtensions.map((entry) => entry.id),
    ['pro', 'team', 'demo'],
  );
  for (const forbiddenKey of ['policy', 'pendingApprovals', 'auditEvents', 'detectedDeviceIdentity']) {
    assert.ok(!(forbiddenKey in neutral.json), `/api/state must remain host-neutral: ${forbiddenKey}`);
  }
  assertPrivateMarkersAbsent(neutral.json);

  const proState = await api(controlCenter, '/api/pro/state');
  assert.strictEqual(proState.response.status, 200);
  assert.strictEqual(proState.json.policy.tier, 'team');
  assert.strictEqual(proState.json.policy.profile, 'safe_developer');
  assert.strictEqual(proState.json.pendingApprovals.length, 1);
  assert.strictEqual(proState.json.pendingApprovals[0].id, pending.id);
  assert.ok(!('auditEvents' in proState.json));
  assert.ok(!('detectedDeviceIdentity' in proState.json));
  assertPrivateMarkersAbsent(proState.json);

  const teamDevice = await api(controlCenter, '/api/team/device');
  assert.strictEqual(teamDevice.response.status, 200);
  assert.deepStrictEqual(teamDevice.json, {
    detectedDeviceIdentity: { deviceId: 'remote-device-1' },
  });
  assertPrivateMarkersAbsent(teamDevice.json);

  const teamAuditBefore = await api(controlCenter, '/api/team/audit');
  assert.strictEqual(teamAuditBefore.response.status, 200);
  assert.deepStrictEqual(teamAuditBefore.json.auditEvents, []);

  const deniedWithoutToken = await api(
    controlCenter,
    `/api/pro/approvals/${pending.id}/approve`,
    { method: 'POST', token: 'wrong-token' },
  );
  assert.strictEqual(deniedWithoutToken.response.status, 403);
  const approved = await api(
    controlCenter,
    `/api/pro/approvals/${pending.id}/approve`,
    { method: 'POST' },
  );
  assert.strictEqual(approved.response.status, 200);
  assert.strictEqual(approved.json.status, 'approved');
  assertPrivateMarkersAbsent(approved.json);

  const teamAuditAfter = await api(controlCenter, '/api/team/audit');
  assert.strictEqual(teamAuditAfter.response.status, 200);
  assert.strictEqual(teamAuditAfter.json.auditEvents.length, 1);
  assert.strictEqual(teamAuditAfter.json.auditEvents[0].type, 'approval_decision');
  assert.strictEqual(teamAuditAfter.json.auditEvents[0].approvalDecision, 'approved');
  assertPrivateMarkersAbsent(teamAuditAfter.json);

  const profile = await api(controlCenter, '/api/pro/profile/read_only', { method: 'POST' });
  assert.strictEqual(profile.response.status, 200);
  assert.strictEqual(profile.json.profile, 'read_only');

  const folder = await api(controlCenter, '/api/pro/folders', {
    method: 'POST',
    body: { path: tempDir, permission: 'read_only' },
  });
  assert.strictEqual(folder.response.status, 200);
  assert.deepStrictEqual(folder.json.folderPermissions, [{
    path: tempDir,
    permission: 'read_only',
  }]);
  const scopedFolder = await api(controlCenter, '/api/pro/folders', {
    method: 'POST',
    body: { path: tempDir, permission: 'blocked', deviceId: 'remote-device-1' },
  });
  assert.strictEqual(scopedFolder.response.status, 400);

  const invalidFolder = await api(controlCenter, '/api/pro/folders', {
    method: 'POST',
    body: { path: 'relative/not-allowed', permission: 'blocked' },
  });
  assert.strictEqual(invalidFolder.response.status, 400);

  const command = await api(controlCenter, '/api/pro/commands', {
    method: 'POST',
    body: { commandPrefix: 'git push', permission: 'approval_required' },
  });
  assert.strictEqual(command.response.status, 200);
  assert.deepStrictEqual(command.json.commandPermissions, [{
    commandPrefix: 'git push',
    permission: 'approval_required',
  }]);
  const invalidCommand = await api(controlCenter, '/api/pro/commands', {
    method: 'POST',
    body: { commandPrefix: '', permission: 'blocked' },
  });
  assert.strictEqual(invalidCommand.response.status, 400);

  const device = await api(controlCenter, '/api/team/device', {
    method: 'POST', body: { deviceId: 'remote-device-1' },
  });
  assert.strictEqual(device.response.status, 200);
  assert.deepStrictEqual(device.json, { deviceId: 'remote-device-1' });

  const invalidProfile = await api(
    controlCenter,
    '/api/pro/profile/not-a-real-profile',
    { method: 'POST' },
  );
  assert.strictEqual(invalidProfile.response.status, 400);

  let persistedPolicy = JSON.parse(await fs.readFile(policyFile, 'utf8'));
  assert.strictEqual(persistedPolicy.profile, 'read_only');
  assert.strictEqual(persistedPolicy.tier, 'team');
  assert.strictEqual(persistedPolicy.deviceId, 'remote-device-1');

  const tier = await api(controlCenter, '/api/demo/tier/pro', { method: 'POST' });
  assert.strictEqual(tier.response.status, 200);
  assert.deepStrictEqual(tier.json, { tier: 'pro' });
  persistedPolicy = JSON.parse(await fs.readFile(policyFile, 'utf8'));
  assert.strictEqual(persistedPolicy.tier, 'pro');

  const stateAfterTier = await api(controlCenter, '/api/state');
  assert.strictEqual(stateAfterTier.json.entitlement.tier, 'pro');
  assert.deepStrictEqual(
    stateAfterTier.json.activeExtensions.map((entry) => entry.id),
    ['pro', 'demo'],
  );
  const teamAfterTier = await api(controlCenter, '/api/team/device');
  assert.strictEqual(teamAfterTier.response.status, 404);

  const invalidTier = await api(
    controlCenter,
    '/api/demo/tier/enterprise',
    { method: 'POST' },
  );
  assert.strictEqual(invalidTier.response.status, 400);

  const approvals = await listApprovals();
  assert.strictEqual(approvals[0].status, 'approved');
  const audit = await listAuditEvents();
  assert.strictEqual(audit.length, 1);
  assert.strictEqual(audit[0].type, 'approval_decision');
  assert.strictEqual(audit[0].approvalDecision, 'approved');
  assertPrivateMarkersAbsent(audit);

  console.log('✅ Recomposed local web Control Center tests passed');
} finally {
  if (controlCenter) await controlCenter.close();
  for (const key of envKeys) {
    if (oldEnv[key] === undefined) delete process.env[key];
    else process.env[key] = oldEnv[key];
  }
  await fs.rm(tempDir, { recursive: true, force: true });
}
