/**
 * End-to-end integration test for the prototype access-control gate.
 *
 * Drives the real built MCP server over stdio, exactly like an AI client.
 * It proves protected writes are stopped before mutation and that an approval
 * is exact, one-time, and can be consumed without switching the tier to Free.
 */

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import assert from 'node:assert';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { setApprovalDecision } from '../../dist/policy/approval-store.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const PROJECT_ROOT = path.resolve(__dirname, '..', '..');

const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'dc-policy-integration-'));
const testFile = path.join(tempDir, 'protected.txt');
const policyFile = path.join(tempDir, 'policy.json');
const approvalFile = path.join(tempDir, 'approvals.json');

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
    },
  });

  const client = new Client(
    { name: 'desktop-commander-policy-test', version: '1.0.0' },
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
    tier: 'pro',
    rules: [{
      id: 'protected-test-write',
      action: 'filesystem.write',
      resourcePrefix: tempDir,
      decision: 'require_approval',
    }],
  }));

  const client = await createClient();

  try {
    const writeArgs = {
      path: testFile,
      content: 'approved-change',
      mode: 'rewrite',
    };

    const blocked = await client.callTool({
      name: 'write_file',
      arguments: writeArgs,
    });

    assert.strictEqual(blocked.isError, true, 'Protected write should be stopped');
    assert.match(firstText(blocked), /Approval required/i);
    assert.match(firstText(blocked), /No action was executed/i);
    const approvalId = approvalIdFrom(blocked);
    assert.ok(approvalId, 'Blocked response should include an approval request ID');
    assert.strictEqual(
      await fs.readFile(testFile, 'utf8'),
      'original',
      'The real file must remain unchanged while approval is pending'
    );

    const approved = await setApprovalDecision(approvalId, 'approved', approvalFile);
    assert.strictEqual(approved?.status, 'approved');

    const retried = await client.callTool({
      name: 'write_file',
      arguments: writeArgs,
    });

    assert.ok(!retried.isError, 'Approved exact retry should reach upstream write_file');
    assert.strictEqual(
      await fs.readFile(testFile, 'utf8'),
      'approved-change',
      'Approved retry should mutate the real file'
    );

    // Approval is one-time. Reset the file outside MCP, then repeat the exact
    // request: it must require a fresh approval and leave the reset content.
    await fs.writeFile(testFile, 'reset-after-consume');

    const secondBlocked = await client.callTool({
      name: 'write_file',
      arguments: writeArgs,
    });

    assert.strictEqual(secondBlocked.isError, true, 'Consumed approval must not be reusable');
    assert.ok(approvalIdFrom(secondBlocked), 'A fresh request should be created');
    assert.notStrictEqual(
      approvalIdFrom(secondBlocked),
      approvalId,
      'Fresh approval should have a new request ID'
    );
    assert.strictEqual(
      await fs.readFile(testFile, 'utf8'),
      'reset-after-consume',
      'One-time approval must prevent a second write'
    );

    // Free still preserves upstream low-friction behavior.
    await fs.writeFile(policyFile, JSON.stringify({
      version: 1,
      tier: 'free',
      rules: [],
    }));

    const freeWrite = await client.callTool({
      name: 'write_file',
      arguments: writeArgs,
    });

    assert.ok(!freeWrite.isError, 'Free write should continue to upstream handler');
    assert.strictEqual(
      await fs.readFile(testFile, 'utf8'),
      'approved-change'
    );

    console.log('✅ Real MCP write approval integration test passed');
  } finally {
    await client.close();
  }
} finally {
  await fs.rm(tempDir, { recursive: true, force: true });
}
