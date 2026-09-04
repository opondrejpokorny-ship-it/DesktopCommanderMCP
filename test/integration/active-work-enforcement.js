/**
 * RED -> GREEN: server-side Active Work registration enforcement.
 */
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  listApprovals,
  setApprovalDecision,
} from '../../dist/policy/approval-store.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(here, '..', '..');
const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'dc-active-work-enforce-'));
const repoA = path.join(tempDir, 'repo-a');
const repoB = path.join(tempDir, 'repo-b');
const stateRoot = path.join(tempDir, 'state');
const policyFile = path.join(tempDir, 'policy.json');
const approvalFile = path.join(tempDir, 'approvals.json');

function git(cwd, ...args) {
  return execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8' }).trim();
}

function firstText(result) {
  return result?.content?.find?.((item) => item.type === 'text')?.text ?? '';
}

function approvalIdFrom(result) {
  return firstText(result).match(/Approval request ID:\s*([0-9a-f-]+)/i)?.[1] ?? null;
}

async function exists(target) {
  return fs.stat(target).then(() => true, () => false);
}

function transport() {
  return new StdioClientTransport({
    command: process.execPath,
    args: [path.join(projectRoot, 'dist/index.js'), '--no-onboarding'],
    cwd: projectRoot,
    stderr: 'pipe',
    env: {
      ...process.env,
      DESKTOP_COMMANDER_DISABLE_TELEMETRY: 'true',
      DESKTOP_COMMANDER_POLICY_FILE: policyFile,
      DESKTOP_COMMANDER_APPROVAL_FILE: approvalFile,
      DESKTOP_COMMANDER_WORKFLOW_STATE_DIR: stateRoot,
    },
  });
}

try {
  await fs.mkdir(path.join(repoA, 'src'), { recursive: true });
  execFileSync('git', ['init', repoA]);
  git(repoA, 'config', 'user.email', 'test@example.invalid');
  git(repoA, 'config', 'user.name', 'Active Work Enforcement Test');
  await fs.writeFile(path.join(repoA, 'README.md'), '# Enforcement\n');
  git(repoA, 'add', '.');
  git(repoA, 'commit', '-m', 'baseline');
  git(repoA, 'remote', 'add', 'origin', 'https://github.com/example/enforcement.git');
  git(repoA, 'worktree', 'add', '-b', 'worker-b', repoB);

  await fs.writeFile(policyFile, JSON.stringify({ version: 1, tier: 'free', rules: [] }));

  const client = new Client(
    { name: 'active-work-enforcement-test', version: '1.0.0' },
    { capabilities: {} },
  );
  await client.connect(transport(), { timeout: 30000 });

  try {
    const unregistered = path.join(repoA, 'src', 'unregistered.txt');
    const blocked = await client.callTool({
      name: 'write_file',
      arguments: { path: unregistered, content: 'must-not-write', mode: 'rewrite' },
    });
    assert.equal(blocked.isError, true);
    assert.match(firstText(blocked), /ACTIVE_WORK_REGISTRATION_REQUIRED/);
    assert.equal(await exists(unregistered), false);

    const forgedUiTarget = path.join(repoA, 'src', 'forged-ui.txt');
    const forgedUi = await client.callTool({
      name: 'write_file',
      arguments: {
        path: forgedUiTarget,
        content: 'must-not-bypass',
        mode: 'rewrite',
        origin: 'ui',
      },
    });
    assert.equal(forgedUi.isError, true);
    assert.match(firstText(forgedUi), /ACTIVE_WORK_REGISTRATION_REQUIRED/);
    assert.equal(await exists(forgedUiTarget), false);

    const outside = path.join(tempDir, 'outside.txt');
    const outsideWrite = await client.callTool({
      name: 'write_file',
      arguments: { path: outside, content: 'outside-ok', mode: 'rewrite' },
    });
    assert.ok(!outsideWrite.isError, firstText(outsideWrite));
    assert.equal(await fs.readFile(outside, 'utf8'), 'outside-ok');

    const registered = await client.callTool({
      name: 'active_work_registry',
      arguments: {
        action: 'register',
        projectRoot: repoA,
        title: 'Enforced file edit',
        scope: 'Edit one registered file',
        affectedAreas: ['src/allowed.txt'],
        nextAction: 'Write the registered target',
      },
    });
    assert.equal(registered.structuredContent?.registered, true);
    const entryId = registered.structuredContent?.entry?.id;
    assert.ok(entryId);

    const allowed = path.join(repoA, 'src', 'allowed.txt');
    const allowedWrite = await client.callTool({
      name: 'write_file',
      arguments: { path: allowed, content: 'registered-ok', mode: 'rewrite' },
    });
    assert.ok(!allowedWrite.isError, firstText(allowedWrite));
    assert.equal(await fs.readFile(allowed, 'utf8'), 'registered-ok');

    const outOfScope = path.join(repoA, 'src', 'not-covered.txt');
    const scopeBlocked = await client.callTool({
      name: 'write_file',
      arguments: { path: outOfScope, content: 'nope', mode: 'rewrite' },
    });
    assert.equal(scopeBlocked.isError, true);
    assert.match(firstText(scopeBlocked), /ACTIVE_WORK_SCOPE_UPDATE_REQUIRED/);
    assert.equal(await exists(outOfScope), false);

    const removed = await client.callTool({
      name: 'active_work_registry',
      arguments: { action: 'remove', projectRoot: repoA, entryId },
    });
    assert.equal(removed.structuredContent?.removed, true);

    const otherWorktree = await client.callTool({
      name: 'active_work_registry',
      arguments: {
        action: 'register',
        projectRoot: repoB,
        title: 'Other worktree edit',
        scope: 'Edit the same relative file from another worktree',
        affectedAreas: ['src/cross.txt'],
      },
    });
    assert.equal(otherWorktree.structuredContent?.registered, true);
    const otherEntryId = otherWorktree.structuredContent?.entry?.id;
    assert.ok(otherEntryId);

    const crossTarget = path.join(repoA, 'src', 'cross.txt');
    const crossBlocked = await client.callTool({
      name: 'write_file',
      arguments: { path: crossTarget, content: 'wrong-worktree', mode: 'rewrite' },
    });
    assert.equal(crossBlocked.isError, true);
    assert.match(firstText(crossBlocked), /ACTIVE_WORK_REGISTRATION_REQUIRED/);
    assert.equal(await exists(crossTarget), false);

    await client.callTool({
      name: 'active_work_registry',
      arguments: { action: 'remove', projectRoot: repoB, entryId: otherEntryId },
    });

    await fs.writeFile(policyFile, JSON.stringify({
      version: 1,
      tier: 'pro',
      rules: [{
        id: 'approval-after-registration',
        action: 'filesystem.write',
        resourcePrefix: repoA,
        decision: 'require_approval',
      }],
    }));

    const protectedTarget = path.join(repoA, 'src', 'protected.txt');
    const preRegistration = await client.callTool({
      name: 'write_file',
      arguments: { path: protectedTarget, content: 'approved-later', mode: 'rewrite' },
    });
    assert.equal(preRegistration.isError, true);
    assert.match(firstText(preRegistration), /ACTIVE_WORK_REGISTRATION_REQUIRED/);
    assert.equal((await listApprovals(approvalFile)).length, 0);
    assert.equal(await exists(protectedTarget), false);

    const protectedRegistration = await client.callTool({
      name: 'active_work_registry',
      arguments: {
        action: 'register',
        projectRoot: repoA,
        title: 'Protected registered write',
        scope: 'Write the protected target after registration',
        affectedAreas: ['src/protected.txt'],
      },
    });
    assert.equal(protectedRegistration.structuredContent?.registered, true);

    const approvalRequired = await client.callTool({
      name: 'write_file',
      arguments: { path: protectedTarget, content: 'approved-later', mode: 'rewrite' },
    });
    assert.equal(approvalRequired.isError, true);
    assert.match(firstText(approvalRequired), /Approval required/i);
    const approvalId = approvalIdFrom(approvalRequired);
    assert.ok(approvalId);
    assert.equal((await listApprovals(approvalFile)).length, 1);
    assert.equal(await exists(protectedTarget), false);

    const approved = await setApprovalDecision(approvalId, 'approved', approvalFile);
    assert.equal(approved?.status, 'approved');

    const exactRetry = await client.callTool({
      name: 'write_file',
      arguments: { path: protectedTarget, content: 'approved-later', mode: 'rewrite' },
    });
    assert.ok(!exactRetry.isError, firstText(exactRetry));
    assert.equal(await fs.readFile(protectedTarget, 'utf8'), 'approved-later');
    assert.equal((await listApprovals(approvalFile))[0]?.status, 'consumed');

    console.log('✅ Real MCP active work enforcement integration passed');
  } finally {
    await client.close();
  }
} finally {
  await fs.rm(tempDir, { recursive: true, force: true });
}
