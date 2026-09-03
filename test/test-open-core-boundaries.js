import assert from 'node:assert';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  createPendingApproval,
  setApprovalDecision,
} from '../dist/policy/approval-store.js';

const __filename = fileURLToPath(import.meta.url);
const root = path.resolve(path.dirname(__filename), '..');

const approvalSource = await fs.readFile(
  path.join(root, 'src/policy/approval-store.ts'),
  'utf8',
);
const policyGateSource = await fs.readFile(
  path.join(root, 'src/policy/policy-gate.ts'),
  'utf8',
);

assert.doesNotMatch(
  approvalSource,
  /from ['"].*audit-store/,
  'Pro approval storage must not import Team audit storage',
);
assert.doesNotMatch(
  policyGateSource,
  /from ['"].*audit-store/,
  'Pro policy/approval gate must not import Team audit storage',
);

const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'dc-approval-audit-decouple-'));
const approvalFile = path.join(tempDir, 'approvals.json');
const events = [];
const sink = {
  append: async (event) => {
    events.push(event);
  },
};

try {
  const pending = await createPendingApproval({
    tool: 'write_file',
    args: { path: '/tmp/pro.txt', content: 'secret-never-persist' },
    ruleId: 'pro-write',
    resource: '/tmp/pro.txt',
    action: 'filesystem.write',
    auditRequestId: 'team-audit-request',
  }, approvalFile);

  const approved = await setApprovalDecision(
    pending.id,
    'approved',
    approvalFile,
    sink,
  );

  assert.strictEqual(approved?.status, 'approved');
  assert.strictEqual(events.length, 1);
  assert.strictEqual(events[0].type, 'approval_decision');
  assert.strictEqual(events[0].requestId, 'team-audit-request');
  assert.strictEqual(events[0].approvalRequestId, pending.id);

  const standalonePending = await createPendingApproval({
    tool: 'write_file',
    args: { path: '/tmp/pro-standalone.txt', content: 'standalone' },
    ruleId: 'pro-standalone',
    resource: '/tmp/pro-standalone.txt',
    action: 'filesystem.write',
    auditRequestId: 'unused-team-audit-request',
  }, approvalFile);

  const standaloneApproved = await setApprovalDecision(
    standalonePending.id,
    'approved',
    approvalFile,
  );
  assert.strictEqual(
    standaloneApproved?.status,
    'approved',
    'Pro approval must work with no Team audit sink present',
  );

  console.log('✅ Pro approval / Team audit decoupling tests passed');
} finally {
  await fs.rm(tempDir, { recursive: true, force: true });
}
