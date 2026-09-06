import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { startControlCenterHost } from '../dist/control-center-contract.js';
import { createProControlCenterExtension } from '../dist/control-center/pro-extension.js';
import { createTeamControlCenterExtension } from '../dist/control-center/team-extension.js';

const PRIVATE_ACCESS = 'PRIVATE_TEAM_ACCESS_TOKEN';
const PRIVATE_REFRESH = 'PRIVATE_TEAM_REFRESH_TOKEN';
const PRIVATE_COMMAND = 'rm -rf PRIVATE_TEAM_COMMAND';
const PRIVATE_FILE = 'PRIVATE_TEAM_FILE_CONTENT';
const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'dc-c3-team-extension-'));
const policyFile = path.join(tempDir, 'policy.json');
const auditFile = path.join(tempDir, 'audit.jsonl');
const deviceFile = path.join(tempDir, 'device.json');
const envKeys = [
  'DESKTOP_COMMANDER_POLICY_FILE',
  'DESKTOP_COMMANDER_AUDIT_FILE',
  'DESKTOP_COMMANDER_REMOTE_DEVICE_CONFIG_FILE',
];
const oldEnv = Object.fromEntries(envKeys.map((key) => [key, process.env[key]]));
process.env.DESKTOP_COMMANDER_POLICY_FILE = policyFile;
process.env.DESKTOP_COMMANDER_AUDIT_FILE = auditFile;
process.env.DESKTOP_COMMANDER_REMOTE_DEVICE_CONFIG_FILE = deviceFile;
const proEntitlement = {
  async getEntitlement() {
    return {
      source: 'prototype', tier: 'pro',
      capabilities: ['policy.config', 'approvals.local'],
    };
  },
};
const teamEntitlement = {
  async getEntitlement() {
    return {
      source: 'prototype', tier: 'team',
      capabilities: [
        'policy.config', 'approvals.local',
        'team.device_policy', 'audit.local',
      ],
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
    method, headers,
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const text = await response.text();
  return { status: response.status, text, json: text ? JSON.parse(text) : null };
}

function assertPrivateMarkersAbsent(value) {
  const serialized = JSON.stringify(value);
  for (const marker of [PRIVATE_ACCESS, PRIVATE_REFRESH, PRIVATE_COMMAND, PRIVATE_FILE]) {
    assert.ok(!serialized.includes(marker), `Team response leaked ${marker}`);
  }
}

await fs.writeFile(policyFile, JSON.stringify({
  version: 1, tier: 'team', profile: 'safe_developer', rules: [],
}, null, 2), 'utf8');
await fs.writeFile(deviceFile, JSON.stringify({
  deviceId: 'team-device-123',
  session: { access_token: PRIVATE_ACCESS, refresh_token: PRIVATE_REFRESH },
}, null, 2), 'utf8');
const auditLines = Array.from({ length: 205 }, (_, index) => JSON.stringify({
  id: `audit-${index}`,
  timestamp: new Date(Date.now() + index).toISOString(),
  type: 'policy_decision', requestId: `request-${index}`,
  tool: index % 2 ? 'write_file' : 'start_process',
  action: index % 2 ? 'filesystem.write' : 'terminal.execute',
  decision: 'require_approval', ruleId: `rule-${index}`,
  rawCommand: PRIVATE_COMMAND, fileContent: PRIVATE_FILE, authToken: PRIVATE_ACCESS,
}));
await fs.writeFile(auditFile, `${auditLines.join('\n')}\n`, 'utf8');
const proOnly = await startControlCenterHost({
  port: 0, token: 'c3-team-pro-only', quiet: true,
  entitlementProvider: proEntitlement,
  extensions: [createProControlCenterExtension()],
});
try {
  const missingTeam = await api(proOnly, '/api/team/device');
  assert.strictEqual(missingTeam.status, 404);
} finally {
  await proOnly.close();
}

const teamExtension = createTeamControlCenterExtension();
assert.strictEqual(teamExtension.id, 'team');
assert.deepStrictEqual(teamExtension.apiPrefixes, ['/api/team']);
assert.deepStrictEqual(teamExtension.requiredCapabilities, ['team.device_policy', 'audit.local']);
assert.ok(teamExtension.ui, 'Team extension must contribute its trusted first-party UI');
assert.match(teamExtension.ui.script ?? '', /window\.dcControlCenter\.api/);
assert.match(teamExtension.ui.script ?? '', /textContent/);
assert.ok(!(teamExtension.ui.script ?? '').includes('.innerHTML'));

const running = await startControlCenterHost({
  port: 0, token: 'c3-team-token', quiet: true,
  entitlementProvider: teamEntitlement,
  extensions: [createProControlCenterExtension(), teamExtension],
});
try {
  const device = await api(running, '/api/team/device');
  assert.strictEqual(device.status, 200);
  assert.deepStrictEqual(device.json, {
    detectedDeviceIdentity: { deviceId: 'team-device-123' },
  });
  assertPrivateMarkersAbsent(device.json);
  const audit = await api(running, '/api/team/audit');
  assert.strictEqual(audit.status, 200);
  assert.ok(Array.isArray(audit.json.auditEvents));
  assert.strictEqual(audit.json.auditEvents.length, 200, 'Team audit response must remain bounded');
  assert.strictEqual(audit.json.auditEvents[0].id, 'audit-5');
  assertPrivateMarkersAbsent(audit.json);
  for (const event of audit.json.auditEvents) {
    for (const forbidden of ['rawCommand', 'fileContent', 'authToken']) {
      assert.ok(!(forbidden in event), `Team audit response exposed ${forbidden}`);
    }
  }

  const selected = await api(running, '/api/team/device', {
    method: 'POST', body: { deviceId: 'team-device-selected' },
  });
  assert.strictEqual(selected.status, 200);
  assert.deepStrictEqual(selected.json, { deviceId: 'team-device-selected' });
  const selectedPolicy = JSON.parse(await fs.readFile(policyFile, 'utf8'));
  assert.strictEqual(selectedPolicy.deviceId, 'team-device-selected');

  const invalid = await api(running, '/api/team/device', {
    method: 'POST', body: { deviceId: '   ' },
  });
  assert.strictEqual(invalid.status, 400);
} finally {
  await running.close();
}

await fs.writeFile(policyFile, JSON.stringify({
  version: 1, tier: 'pro', profile: 'safe_developer', rules: [],
}, null, 2), 'utf8');
const mistakenTeamRegistration = await startControlCenterHost({
  port: 0, token: 'c3-team-pro-gate', quiet: true,
  entitlementProvider: proEntitlement,
  extensions: [teamExtension],
});
try {
  const denied = await api(mistakenTeamRegistration, '/api/team/device', {
    method: 'POST', body: { deviceId: 'must-not-be-written' },
  });
  assert.strictEqual(denied.status, 404);
  const unchanged = JSON.parse(await fs.readFile(policyFile, 'utf8'));
  assert.ok(!('deviceId' in unchanged), 'Host capability gate must run before Team mutation');
} finally {
  await mistakenTeamRegistration.close();
}

const distSource = await fs.readFile(
  new URL('../dist/control-center/team-extension.js', import.meta.url), 'utf8',
);
assert.ok(distSource.includes('audit-store'));
assert.ok(distSource.includes('device-identity'));
assert.ok(!distSource.includes('prototype-audit-sink'));

for (const key of envKeys) {
  if (oldEnv[key] === undefined) delete process.env[key];
  else process.env[key] = oldEnv[key];
}
await fs.rm(tempDir, { recursive: true, force: true });
console.log('C3 Team Control Center extension tests passed');
