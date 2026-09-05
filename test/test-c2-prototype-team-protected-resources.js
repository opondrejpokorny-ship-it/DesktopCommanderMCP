/** C2 regression: demo Team composition must still protect Team audit storage. */
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { CapabilityRegistry } from '../dist/entitlements/capabilities.js';
import { PrototypePolicyHook } from '../dist/prototype/prototype-policy-hook.js';

const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'dc-c2-prototype-team-'));
const policyFile = path.join(tempDir, 'policy.json');
const approvalFile = path.join(tempDir, 'approvals.json');
const auditFile = path.join(tempDir, 'audit.jsonl');
const ordinaryFile = path.join(tempDir, 'ordinary.txt');
const previous = {
  policy: process.env.DESKTOP_COMMANDER_POLICY_FILE,
  approval: process.env.DESKTOP_COMMANDER_APPROVAL_FILE,
  audit: process.env.DESKTOP_COMMANDER_AUDIT_FILE,
};
try {
  process.env.DESKTOP_COMMANDER_POLICY_FILE = policyFile;
  process.env.DESKTOP_COMMANDER_APPROVAL_FILE = approvalFile;
  process.env.DESKTOP_COMMANDER_AUDIT_FILE = auditFile;
  await fs.writeFile(policyFile, JSON.stringify({
    version: 1,
    tier: 'team',
    profile: 'full_access',
    rules: [],
  }));
  const capabilities = new CapabilityRegistry([
    'policy.filesystem',
    'approvals.local',
    'audit.local',
    'team.device_policy',
  ]);
  const hook = new PrototypePolicyHook();
  const auditGate = await hook.preflight(
    'write_file',
    { path: auditFile, content: 'tamper' },
    capabilities,
  );
  assert.strictEqual(auditGate.allowed, false);
  assert.strictEqual(auditGate.decision, 'deny');
  const ordinaryGate = await hook.preflight(
    'write_file',
    { path: ordinaryFile, content: 'normal' },
    capabilities,
  );
  assert.strictEqual(ordinaryGate.allowed, true);
  assert.strictEqual(ordinaryGate.decision, 'allow');
  console.log('✅ C2 prototype Team protected-resource composition passed');
} finally {
  for (const [key, value] of Object.entries(previous)) {
    const envKey = key === 'policy'
      ? 'DESKTOP_COMMANDER_POLICY_FILE'
      : key === 'approval'
        ? 'DESKTOP_COMMANDER_APPROVAL_FILE'
        : 'DESKTOP_COMMANDER_AUDIT_FILE';
    if (value === undefined) delete process.env[envKey];
    else process.env[envKey] = value;
  }
  await fs.rm(tempDir, { recursive: true, force: true });
}
