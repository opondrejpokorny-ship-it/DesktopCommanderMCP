/**
 * RED -> GREEN tests for privacy-conscious access audit storage.
 */

import assert from 'node:assert';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  appendAuditEvent,
  listAuditEvents,
} from '../dist/policy/audit-store.js';

const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'dc-audit-test-'));
const auditFile = path.join(tempDir, 'audit.jsonl');

try {
  const policyEvent = await appendAuditEvent({
    type: 'policy_decision',
    requestId: 'request-1',
    tool: 'write_file',
    action: 'filesystem.write',
    resource: '/projects/production/app.ts',
    decision: 'require_approval',
    ruleId: 'production-write',
    approvalRequestId: 'approval-1',
  }, auditFile);

  assert.ok(policyEvent.id);
  assert.ok(policyEvent.timestamp);

  await appendAuditEvent({
    type: 'execution_result',
    requestId: 'request-1',
    tool: 'write_file',
    action: 'filesystem.write',
    resource: '/projects/production/app.ts',
    outcome: 'success',
    durationMs: 42,
  }, auditFile);

  // Terminal resources may contain secrets; the store should omit them.
  await appendAuditEvent({
    type: 'policy_decision',
    requestId: 'request-2',
    tool: 'start_process',
    action: 'terminal.execute',
    resource: 'curl -H "Authorization: Bearer super-secret-token" example.test',
    decision: 'require_approval',
  }, auditFile);

  const records = await listAuditEvents(auditFile);
  assert.strictEqual(records.length, 3);
  assert.strictEqual(records[0].resource, '/projects/production/app.ts');
  assert.strictEqual(records[2].resource, undefined);

  const raw = await fs.readFile(auditFile, 'utf8');
  assert.ok(!raw.includes('super-secret-token'), 'Audit log must not persist terminal command secrets');
  assert.ok(!raw.includes('Authorization: Bearer'), 'Audit log must not persist raw terminal command text');

  console.log('✅ Audit store tests passed');
} finally {
  await fs.rm(tempDir, { recursive: true, force: true });
}
