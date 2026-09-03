[Reading 155 lines from start (total: 155 lines, 0 remaining)]

/**
 * End-to-end terminal policy integration test.
 *
 * Proves start_process is blocked before spawning, then can run exactly once
 * after approval, with the approval bound to the exact command arguments.
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

const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'dc-terminal-policy-'));
const markerFile = path.join(tempDir, 'executed.txt');
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
    { name: 'desktop-commander-terminal-policy-test', version: '1.0.0' },
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

async function exists(filePath) {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

async function waitForFile(filePath, timeoutMs = 3000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await exists(filePath)) return true;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  return exists(filePath);
}

try {
  await fs.writeFile(policyFile, JSON.stringify({
    version: 1,
    tier: 'pro',
    rules: [{
      id: 'terminal-needs-approval',
      action: 'terminal.execute',
      decision: 'require_approval',
    }],
  }));

  const scriptPath = markerFile.replace(/\\/g, '/').replace(/'/g, "\\'");
  const script = `require('fs').writeFileSync('${scriptPath}', 'executed')`;
  const args = process.platform === 'win32'
    ? {
        command: `& '${process.execPath.replace(/'/g, "''")}' -e \"${script}\"`,
        timeout_ms: 5000,
        shell: 'powershell.exe',
      }
    : {
        command: `${JSON.stringify(process.execPath)} -e ${JSON.stringify(script)}`,
        timeout_ms: 5000,
      };

  const client = await createClient();

  try {
    const blocked = await client.callTool({
      name: 'start_process',
      arguments: args,
    });

    assert.strictEqual(blocked.isError, true, 'Terminal command should require approval');
    const approvalId = approvalIdFrom(blocked);
    assert.ok(approvalId, 'Blocked terminal call should create an approval request');
    assert.strictEqual(
      await exists(markerFile),
      false,
      'Blocked terminal action must not spawn the process'
    );

    const approved = await setApprovalDecision(approvalId, 'approved', approvalFile);
    assert.strictEqual(approved?.status, 'approved');

    const allowed = await client.callTool({
      name: 'start_process',
      arguments: args,
    });

    assert.ok(!allowed.isError, 'Approved exact terminal retry should execute');
    assert.strictEqual(
      await waitForFile(markerFile),
      true,
      'Approved terminal process should create its marker within 3 seconds'
    );
    assert.strictEqual(
      await fs.readFile(markerFile, 'utf8'),
      'executed',
      'Approved terminal process should produce its real side effect'
    );

    await fs.rm(markerFile, { force: true });

    const blockedAgain = await client.callTool({
      name: 'start_process',
      arguments: args,
    });

    assert.strictEqual(blockedAgain.isError, true, 'Terminal approval must be one-time');
    assert.strictEqual(
      await exists(markerFile),
      false,
      'Consumed terminal approval must not allow a second spawn'
    );

    console.log('✅ Real MCP terminal approval integration test passed');
  } finally {
    await client.close();
  }
} finally {
  await fs.rm(tempDir, { recursive: true, force: true });
}

[executed on device: WIN-A0OFGC4ORFI (998ddf48-83cd-4223-bfeb-7ac96a8f7a93)]