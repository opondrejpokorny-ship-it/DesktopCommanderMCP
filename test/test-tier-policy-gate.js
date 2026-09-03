/**
 * RED -> GREEN tests for the policy gate used by the MCP request handler.
 */

import assert from 'node:assert';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { applyPolicyGate } from '../dist/policy/policy-gate.js';

const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'dc-policy-gate-test-'));
const proPolicy = path.join(tempDir, 'pro.json');
const denyPolicy = path.join(tempDir, 'deny.json');
const invalidPolicy = path.join(tempDir, 'invalid.json');
const missingPolicy = path.join(tempDir, 'missing.json');
const approvalFile = path.join(tempDir, 'approvals.json');

try {
  await fs.writeFile(proPolicy, JSON.stringify({
    version: 1,
    tier: 'pro',
    rules: [{
      id: 'write-needs-approval',
      action: 'filesystem.write',
      resourcePrefix: '/projects/production',
      decision: 'require_approval'
    }]
  }));

  const approval = await applyPolicyGate(
    'write_file',
    { path: '/projects/production/app.ts', content: 'change' },
    proPolicy,
    approvalFile
  );

  assert.strictEqual(approval.allowed, false);
  assert.strictEqual(approval.decision, 'require_approval');
  assert.strictEqual(approval.matchedRuleId, 'write-needs-approval');
  assert.strictEqual(approval.result?.isError, true);
  assert.match(approval.result?.content?.[0]?.text ?? '', /Approval required/i);
  assert.match(approval.result?.content?.[0]?.text ?? '', /No action was executed/i);
  assert.match(approval.result?.content?.[0]?.text ?? '', /Approval request ID:/i);

  await fs.writeFile(denyPolicy, JSON.stringify({
    version: 1,
    tier: 'team',
    rules: [{
      id: 'no-config-changes',
      action: 'config.change',
      decision: 'deny'
    }]
  }));

  const denied = await applyPolicyGate(
    'set_config_value',
    { key: 'allowedDirectories', value: [] },
    denyPolicy,
    approvalFile
  );

  assert.strictEqual(denied.allowed, false);
  assert.strictEqual(denied.decision, 'deny');
  assert.match(denied.result?.content?.[0]?.text ?? '', /Blocked by Desktop Commander access policy/i);

  const free = await applyPolicyGate(
    'write_file',
    { path: '/anything/file.txt', content: 'change' },
    missingPolicy,
    approvalFile
  );
  assert.strictEqual(free.allowed, true);
  assert.strictEqual(free.decision, 'allow');

  await fs.writeFile(invalidPolicy, '{ invalid');
  const invalid = await applyPolicyGate(
    'write_file',
    { path: '/anything/file.txt', content: 'change' },
    invalidPolicy,
    approvalFile
  );
  assert.strictEqual(invalid.allowed, false, 'Invalid existing policy must fail closed');
  assert.strictEqual(invalid.decision, 'deny');
  assert.match(invalid.result?.content?.[0]?.text ?? '', /policy configuration error/i);

  console.log('✅ Policy gate tests passed');
} finally {
  await fs.rm(tempDir, { recursive: true, force: true });
}
