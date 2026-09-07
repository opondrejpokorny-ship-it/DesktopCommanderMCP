/**
 * RED -> GREEN regression for atomic one-time approval consumption.
 */

import assert from 'node:assert';
import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  createPendingApproval,
  setApprovalDecision,
  consumeApprovedAction,
  listApprovals,
} from '../dist/policy/approval-store.js';

const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'dc-approval-concurrency-'));
const approvalFile = path.join(tempDir, 'approvals.json');

try {
  const args = {
    path: '/projects/production/app.ts',
    content: 'exact-action-content',
    mode: 'rewrite',
  };

  const pending = await createPendingApproval({
    tool: 'write_file',
    args,
    ruleId: 'production-write',
  }, approvalFile);
  await setApprovalDecision(pending.id, 'approved', approvalFile);

  const results = await Promise.all([
    consumeApprovedAction('write_file', args, approvalFile, 'production-write'),
    consumeApprovedAction('write_file', args, approvalFile, 'production-write'),
  ]);

  const successfulConsumes = results.filter(Boolean);
  assert.strictEqual(
    successfulConsumes.length,
    1,
    'Exactly one concurrent retry may consume a one-time approval',
  );
  assert.strictEqual(successfulConsumes[0]?.id, pending.id);

  const records = await listApprovals(approvalFile);
  const stored = records.find((record) => record.id === pending.id);
  assert.strictEqual(stored?.status, 'consumed');
  assert.ok(stored?.consumedAt);

  const crossProcessFile = path.join(tempDir, 'cross-process-approvals.json');
  const crossProcessArgs = { ...args, content: 'cross-process-content' };
  const crossProcessPending = await createPendingApproval({
    tool: 'write_file',
    args: crossProcessArgs,
    ruleId: 'production-write',
  }, crossProcessFile);
  await setApprovalDecision(crossProcessPending.id, 'approved', crossProcessFile);

  const moduleUrl = new URL('../dist/policy/approval-store.js', import.meta.url).href;
  const childCode = `import(${JSON.stringify(moduleUrl)}).then(async m=>{const r=await m.consumeApprovedAction('write_file',${JSON.stringify(crossProcessArgs)},${JSON.stringify(crossProcessFile)},'production-write');console.log(r?'CONSUMED':'BLOCKED')}).catch(e=>{console.error(e);process.exit(2)})`;
  const runChild = () => new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['-e', childCode]);
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (data) => { stdout += data; });
    child.stderr.on('data', (data) => { stderr += data; });
    child.on('exit', (status) => {
      if (status === 0) resolve(stdout.trim());
      else reject(new Error(stderr || `child exited ${status}`));
    });
  });
  const childResults = await Promise.all([runChild(), runChild()]);
  assert.strictEqual(
    childResults.filter((result) => result === 'CONSUMED').length,
    1,
    'Exactly one process may consume a one-time approval',
  );

  console.log('✅ Approval concurrency test passed');
} finally {
  await fs.rm(tempDir, { recursive: true, force: true });
}
