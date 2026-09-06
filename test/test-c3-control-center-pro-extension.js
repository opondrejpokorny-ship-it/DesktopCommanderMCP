import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createPendingApproval } from '../dist/policy/approval-store.js';
import { startControlCenterHost } from '../dist/control-center-contract.js';
import { createProControlCenterExtension } from '../dist/control-center/pro-extension.js';

const PRIVATE_FILE = 'PRIVATE_PRO_FILE_CONTENT';
const PRIVATE_COMMAND = 'rm -rf PRIVATE_COMMAND';
const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'dc-c3-pro-extension-'));
const policyFile = path.join(tempDir, 'policy.json');
const approvalFile = path.join(tempDir, 'approvals.json');
const oldPolicyFile = process.env.DESKTOP_COMMANDER_POLICY_FILE;
const oldApprovalFile = process.env.DESKTOP_COMMANDER_APPROVAL_FILE;
process.env.DESKTOP_COMMANDER_POLICY_FILE = policyFile;
process.env.DESKTOP_COMMANDER_APPROVAL_FILE = approvalFile;

const entitlementProvider = {
  async getEntitlement() {
    return {
      source: 'prototype',
      tier: 'pro',
      capabilities: ['policy.config', 'approvals.local'],
    };
  },
};
async function api(running, pathname, { method = 'GET', body } = {}) {
  const headers = { 'X-DC-Control-Token': running.token };
  if (method !== 'GET') {
    headers.Origin = new URL(running.url).origin;
    headers['Content-Type'] = 'application/json';
  }
  const response = await fetch(new URL(pathname, running.url), {
    method,
    headers,
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const text = await response.text();
  return {
    status: response.status,
    text,
    json: text ? JSON.parse(text) : null,
  };
}

function assertPrivateMarkersAbsent(value) {
  const serialized = JSON.stringify(value);
  assert.ok(!serialized.includes(PRIVATE_FILE), 'Pro response leaked raw file content');
  assert.ok(!serialized.includes(PRIVATE_COMMAND), 'Pro response leaked raw terminal command');
}

await fs.writeFile(policyFile, JSON.stringify({
  version: 1,
  tier: 'pro',
  profile: 'full_access',
  deviceId: 'TEAM_PRIVATE_DEVICE',
  rules: [{ id: 'team-hidden', action: 'filesystem.write', decision: 'deny', resourcePrefix: 'C:\\TeamPrivate', deviceId: 'TEAM_PRIVATE_DEVICE' }],
}, null, 2), 'utf8');
const fileApproval = await createPendingApproval({
  tool: 'write_file',
  args: { path: 'C:\\Projects\\demo.txt', content: PRIVATE_FILE, mode: 'rewrite' },
  ruleId: 'c3-file',
  resource: 'C:\\Projects\\demo.txt',
  action: 'filesystem.write',
  auditRequestId: 'audit-c3-file',
});
const commandApproval = await createPendingApproval({
  tool: 'start_process',
  args: { command: PRIVATE_COMMAND },
  ruleId: 'c3-command',
  resource: PRIVATE_COMMAND,
  action: 'terminal.execute',
  auditRequestId: 'audit-c3-command',
});

const extension = createProControlCenterExtension();
assert.strictEqual(extension.id, 'pro');
assert.deepStrictEqual(extension.apiPrefixes, ['/api/pro']);
assert.deepStrictEqual(extension.requiredCapabilities, ['policy.config', 'approvals.local']);
assert.ok(extension.ui, 'Pro extension must contribute its trusted first-party UI');
assert.match(extension.ui.script ?? '', /window\.dcControlCenter\.api/);
assert.match(extension.ui.script ?? '', /textContent/);
assert.ok(!(extension.ui.script ?? '').includes('.innerHTML'));

const running = await startControlCenterHost({
  port: 0,
  token: 'c3-pro-token',
  quiet: true,
  entitlementProvider,
  extensions: [extension],
});
try {
  const state = await api(running, '/api/pro/state');
  assert.strictEqual(state.status, 200);
  assert.strictEqual(state.json.policy.tier, 'pro');
  assert.strictEqual(state.json.policy.profile, 'full_access');
  assert.strictEqual(state.json.pendingApprovals.length, 2);
  assert.ok(!('auditEvents' in state.json));
  assert.ok(!('detectedDeviceIdentity' in state.json));
  assert.ok(!JSON.stringify(state.json).includes('TEAM_PRIVATE_DEVICE'));
  assert.ok(!JSON.stringify(state.json).includes('team-hidden'));
  assertPrivateMarkersAbsent(state.json);

  const profile = await api(running, '/api/pro/profile/read_only', { method: 'POST' });
  assert.strictEqual(profile.status, 200);
  assert.strictEqual(profile.json.profile, 'read_only');

  const folders = await api(running, '/api/pro/folders', {
    method: 'POST',
    body: { path: 'C:\\Projects', permission: 'read_only' },
  });
  assert.strictEqual(folders.status, 200);
  assert.ok(folders.json.folderPermissions.some((entry) =>
    entry.path === 'C:\\Projects' && entry.permission === 'read_only'));

  const deviceScopedFolder = await api(running, '/api/pro/folders', { method: 'POST', body: { path: 'C:\\Projects', permission: 'blocked', deviceId: 'TEAM_PRIVATE_DEVICE' } });
  assert.strictEqual(deviceScopedFolder.status, 400, 'Pro must reject Team device-scoped policy mutation');

  const commands = await api(running, '/api/pro/commands', {
    method: 'POST',
    body: { commandPrefix: 'git push', permission: 'approval_required' },
  });
  assert.strictEqual(commands.status, 200);
  assert.ok(commands.json.commandPermissions.some((entry) =>
    entry.commandPrefix === 'git push' && entry.permission === 'approval_required'));
  const approved = await api(
    running,
    `/api/pro/approvals/${encodeURIComponent(fileApproval.id)}/approve`,
    { method: 'POST' },
  );
  assert.strictEqual(approved.status, 200);
  assert.strictEqual(approved.json.status, 'approved');
  assertPrivateMarkersAbsent(approved.json);

  const denied = await api(
    running,
    `/api/pro/approvals/${encodeURIComponent(commandApproval.id)}/deny`,
    { method: 'POST' },
  );
  assert.strictEqual(denied.status, 200);
  assert.strictEqual(denied.json.status, 'denied');
  assertPrivateMarkersAbsent(denied.json);

  const missing = await api(running, '/api/pro/approvals/not-found/approve', {
    method: 'POST',
  });
  assert.strictEqual(missing.status, 404);

  const distSource = await fs.readFile(
    new URL('../dist/control-center/pro-extension.js', import.meta.url),
    'utf8',
  );
  for (const forbidden of ['audit-store', 'device-identity', 'prototype-audit-sink']) {
    assert.ok(!distSource.includes(forbidden), `Pro extension must not import ${forbidden}`);
  }
} finally {
  await running.close();
  if (oldPolicyFile === undefined) delete process.env.DESKTOP_COMMANDER_POLICY_FILE;
  else process.env.DESKTOP_COMMANDER_POLICY_FILE = oldPolicyFile;
  if (oldApprovalFile === undefined) delete process.env.DESKTOP_COMMANDER_APPROVAL_FILE;
  else process.env.DESKTOP_COMMANDER_APPROVAL_FILE = oldApprovalFile;
  await fs.rm(tempDir, { recursive: true, force: true });
}

console.log('C3 Pro Control Center extension tests passed');
