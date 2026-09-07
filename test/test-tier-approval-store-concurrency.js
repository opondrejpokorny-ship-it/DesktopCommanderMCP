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
  const crossProcessStored = JSON.parse(await fs.readFile(crossProcessFile, 'utf8'));
  const crossProcessMatches = crossProcessStored.approvals.filter((record) => record.id === crossProcessPending.id);
  assert.equal(crossProcessMatches.length, 1, 'Cross-process consume must preserve exactly one approval record');
  assert.equal(crossProcessMatches[0]?.status, 'consumed');
  assert.ok(crossProcessMatches[0]?.consumedAt);

  const staleLockFile = path.join(tempDir, 'stale-lock-approvals.json');
  const staleArgs = { path: '/projects/production/stale.ts', content: 'stale' };
  const stalePending = await createPendingApproval({ tool: 'write_file', args: staleArgs, ruleId: 'stale' }, staleLockFile);
  await setApprovalDecision(stalePending.id, 'approved', staleLockFile);
  const staleLockPath = staleLockFile + '.lock';
  await fs.mkdir(staleLockPath);
  const oldTime = new Date(Date.now() - 60_000);
  await fs.utimes(staleLockPath, oldTime, oldTime);
  let staleError;
  try {
    await consumeApprovedAction('write_file', staleArgs, staleLockFile, 'stale');
  } catch (error) {
    staleError = error;
  }
  assert.ok(staleError, 'An abandoned old lock must fail closed instead of being timestamp-reclaimed');
  assert.match(String(staleError?.message), /busy/i);
  const staleStored = JSON.parse(await fs.readFile(staleLockFile, 'utf8'));
  assert.equal(staleStored.approvals.find((record) => record.id === stalePending.id)?.status, 'approved');
  assert.equal((await fs.stat(staleLockPath)).isDirectory(), true, 'fail-closed stale lock must remain for controlled recovery');

  const liveLockFile = path.join(tempDir, 'live-lock-approvals.json');
  const holderArgs = { path: '/projects/production/held.ts', content: 'holder' };
  const holderCode = `
    import fs from 'node:fs/promises';
    const originalWriteFile = fs.writeFile.bind(fs);
    fs.writeFile = async (file, ...rest) => {
      if (String(file) === ${JSON.stringify(liveLockFile)}) {
        await new Promise((resolve) => setTimeout(resolve, 1500));
      }
      return originalWriteFile(file, ...rest);
    };
    const m = await import(${JSON.stringify(moduleUrl)});
    await m.createPendingApproval({ tool: 'write_file', args: ${JSON.stringify(holderArgs)}, ruleId: 'holder' }, ${JSON.stringify(liveLockFile)});
  `;
  const holder = spawn(process.execPath, ['--input-type=module', '-e', holderCode], { stdio: ['pipe', 'pipe', 'pipe'] });


  const holderExit = new Promise((resolve, reject) => {
    holder.once('error', reject);
    holder.once('exit', (code) => code === 0 ? resolve() : reject(new Error('holder exited ' + code)));
  });
  const liveLockPath = liveLockFile + '.lock';
  let holderLocked = false;
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const stat = await fs.stat(liveLockPath).catch(() => null);
    if (stat?.isDirectory()) { holderLocked = true; break; }
    if (holder.exitCode !== null) throw new Error('holder exited before acquiring lock');
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  assert.equal(holderLocked, true, 'holder must acquire the approval lock');
  const staleTime = new Date(Date.now() - 60_000);
  await fs.utimes(liveLockPath, staleTime, staleTime);

  const contenderPromise = createPendingApproval(
    { tool: 'write_file', args: { path: '/projects/production/contender.ts', content: 'contender' }, ruleId: 'contender' },
    liveLockFile,
  ).then(() => 'completed', () => 'failed');
  const earlyOutcome = await Promise.race([
    contenderPromise,
    new Promise((resolve) => setTimeout(() => resolve('waiting'), 500)),
  ]);
  assert.equal(
    earlyOutcome,
    'waiting',
    'A live holder must never be reclaimed solely because its lock mtime looks stale',
  );
  await holderExit;
  assert.equal(await contenderPromise, 'completed');
  const liveStored = JSON.parse(await fs.readFile(liveLockFile, 'utf8'));
  assert.equal(liveStored.approvals.length, 2, 'Holder and contender writes must both survive serialization');
  assert.deepEqual(
    liveStored.approvals.map((record) => [record.ruleId, record.status]).sort((a, b) => a[0].localeCompare(b[0])),
    [['contender', 'pending'], ['holder', 'pending']],
  );


  console.log('✅ Approval concurrency test passed');
} finally {
  await fs.rm(tempDir, { recursive: true, force: true });
}
