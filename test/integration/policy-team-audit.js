/**
 * End-to-end Team audit integration test.
 */

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import assert from 'node:assert';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { setApprovalDecision } from '../../dist/policy/approval-store.js';
import { FileAuditSink, listAuditEvents } from '../../dist/policy/audit-store.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const PROJECT_ROOT = path.resolve(__dirname, '..', '..');

const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'dc-team-audit-integration-'));
const testFile = path.join(tempDir, 'team-protected.txt');
const policyFile = path.join(tempDir, 'policy.json');
const approvalFile = path.join(tempDir, 'approvals.json');
const auditFile = path.join(tempDir, 'audit.jsonl');

async function createClient() {
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [path.join(PROJECT_ROOT, 'dist/index.js'), '--no-onboarding'],
    cwd: PROJECT_ROOT,
    stderr: 'pipe',
    env: {
      ...process.env,
      DESKTOP_COMMANDER_DISABLE_TELEMETRY: 'true',
      DESKTOP_COMMANDER_POLICY_FILE: policyFile,
      DESKTOP_COMMANDER_APPROVAL_FILE: approvalFile,
      DESKTOP_COMMANDER_AUDIT_FILE: auditFile,
    },
  });

  const client = new Client(
    { name: 'desktop-commander-team-audit-test', version: '1.0.0' },
    { capabilities: {} }
  );
  await client.connect(transport, { timeout: 30000 });
  return client;
}

function firstText(result) {
  return result?.content?.find?.((entry) => entry.type === 'text')?.text ?? '';
}

function approvalIdFrom(result) {
  return firstText(result).match(/Approval request ID:\s*([0-9a-f-]+)/i)?.[1] ?? null;
}

try {
  await fs.writeFile(testFile, 'original');
  await fs.writeFile(policyFile, JSON.stringify({
    version: 1,
    tier: 'team',
    deviceId: 'production-server-1',
    rules: [{
      id: 'team-write-approval',
      action: 'filesystem.write',
      deviceId: 'production-server-1',
      resourcePrefix: tempDir,
      decision: 'require_approval',
    }],
  }));

  const client = await createClient();

  try {
    const args = {
      path: testFile,
      content: 'team-approved-change',
      mode: 'rewrite',
    };

    const blocked = await client.callTool({ name: 'write_file', arguments: args });
    assert.strictEqual(blocked.isError, true);
    const approvalId = approvalIdFrom(blocked);
    assert.ok(approvalId);

    let audit = await listAuditEvents(auditFile);
    assert.strictEqual(audit.length, 1);
    assert.strictEqual(audit[0].type, 'policy_decision');
    assert.strictEqual(audit[0].decision, 'require_approval');
    assert.strictEqual(audit[0].deviceId, 'production-server-1');
    assert.strictEqual(audit[0].approvalRequestId, approvalId);

    await setApprovalDecision(
      approvalId,
      'approved',
      approvalFile,
      new FileAuditSink(auditFile)
    );

    const allowed = await client.callTool({ name: 'write_file', arguments: args });
    assert.ok(!allowed.isError);
    assert.strictEqual(await fs.readFile(testFile, 'utf8'), 'team-approved-change');

    audit = await listAuditEvents(auditFile);
    assert.strictEqual(
      audit.length,
      4,
      'Approval + approved retry should add approval, allow, and execution events'
    );

    const approvalEvent = audit[1];
    const allowEvent = audit[2];
    const executionEvent = audit[3];

    assert.strictEqual(approvalEvent.type, 'approval_decision');
    assert.strictEqual(approvalEvent.approvalDecision, 'approved');
    assert.strictEqual(approvalEvent.approvalRequestId, approvalId);
    assert.strictEqual(approvalEvent.requestId, audit[0].requestId);
    assert.strictEqual(approvalEvent.deviceId, 'production-server-1');

    assert.strictEqual(allowEvent.type, 'policy_decision');
    assert.strictEqual(allowEvent.decision, 'allow');
    assert.strictEqual(allowEvent.approvalRequestId, approvalId);

    assert.strictEqual(executionEvent.type, 'execution_result');
    assert.strictEqual(executionEvent.outcome, 'success');
    assert.strictEqual(executionEvent.requestId, allowEvent.requestId);
    assert.strictEqual(executionEvent.deviceId, 'production-server-1');
    assert.strictEqual(executionEvent.resource, testFile);
    assert.ok(typeof executionEvent.durationMs === 'number');

    console.log('✅ Team audit integration test passed');
  } finally {
    await client.close();
  }
} finally {
  await fs.rm(tempDir, { recursive: true, force: true });
}
