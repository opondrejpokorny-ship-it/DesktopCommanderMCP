/**
 * RED -> GREEN tests for one-time approval storage.
 */

import assert from 'node:assert';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  createPendingApproval,
  setApprovalDecision,
  consumeApprovedAction,
  listApprovals,
} from '../dist/policy/approval-store.js';
import { FileAuditSink, listAuditEvents } from '../dist/policy/audit-store.js';

const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'dc-approval-store-test-'));
const approvalFile = path.join(tempDir, 'approvals.json');
const auditFile = path.join(tempDir, 'audit.jsonl');

try {
  const args = {
    path: '/projects/production/app.ts',
    content: 'super-secret-file-content',
    mode: 'rewrite',
  };

  const pending = await createPendingApproval({
    tool: 'write_file',
    args,
    ruleId: 'production-write',
    resource: '/projects/production/app.ts',
    action: 'filesystem.write',
    deviceId: 'team-device-1',
    auditRequestId: 'audit-request-1',
  }, approvalFile);

  assert.ok(pending.id, 'Pending approval should have an ID');
  assert.strictEqual(pending.status, 'pending');
  assert.ok(pending.fingerprint, 'Pending approval should have an action fingerprint');

  const rawStore = await fs.readFile(approvalFile, 'utf8');
  assert.ok(
    !rawStore.includes('super-secret-file-content'),
    'Approval store must not persist raw file content / arguments'
  );

  const duplicate = await createPendingApproval({
    tool: 'write_file',
    args,
    ruleId: 'production-write',
    resource: '/projects/production/app.ts',
  }, approvalFile);
  assert.strictEqual(
    duplicate.id,
    pending.id,
    'Repeated identical blocked requests should reuse the existing pending approval'
  );

  const approved = await setApprovalDecision(
    pending.id,
    'approved',
    approvalFile,
    new FileAuditSink(auditFile)
  );
  assert.strictEqual(approved?.status, 'approved');

  const approvalAudit = await listAuditEvents(auditFile);
  assert.strictEqual(approvalAudit.length, 1);
  assert.strictEqual(approvalAudit[0].type, 'approval_decision');
  assert.strictEqual(approvalAudit[0].requestId, 'audit-request-1');
  assert.strictEqual(approvalAudit[0].approvalRequestId, pending.id);
  assert.strictEqual(approvalAudit[0].approvalDecision, 'approved');
  assert.strictEqual(approvalAudit[0].deviceId, 'team-device-1');

  const consumed = await consumeApprovedAction('write_file', args, approvalFile);
  assert.strictEqual(consumed?.id, pending.id);
  assert.strictEqual(consumed?.status, 'consumed');

  const secondConsume = await consumeApprovedAction('write_file', args, approvalFile);
  assert.strictEqual(secondConsume, null, 'Approval must be one-time');

  const changedArgs = { ...args, content: 'different-content' };
  const changedConsume = await consumeApprovedAction('write_file', changedArgs, approvalFile);
  assert.strictEqual(changedConsume, null, 'Approval must be bound to exact action arguments');

  const deniedPending = await createPendingApproval({
    tool: 'write_file',
    args: changedArgs,
    ruleId: 'production-write',
    resource: '/projects/production/app.ts',
  }, approvalFile);

  await setApprovalDecision(deniedPending.id, 'denied', approvalFile);
  const deniedConsume = await consumeApprovedAction('write_file', changedArgs, approvalFile);
  assert.strictEqual(deniedConsume, null, 'Denied approval can never execute');

  const records = await listApprovals(approvalFile);
  assert.ok(records.some((record) => record.status === 'consumed'));
  assert.ok(records.some((record) => record.status === 'denied'));

  console.log('✅ Approval store tests passed');
} finally {
  await fs.rm(tempDir, { recursive: true, force: true });
}
