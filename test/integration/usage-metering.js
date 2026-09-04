/**
 * Real MCP integration coverage for observational usage metering.
 */

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import assert from 'node:assert';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const PROJECT_ROOT = path.resolve(__dirname, '..', '..');

const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'dc-usage-integration-'));
const usageFile = path.join(tempDir, 'usage.json');
const policyFile = path.join(tempDir, 'policy.json');
const approvalFile = path.join(tempDir, 'approvals.json');
const testFile = path.join(tempDir, 'sample.txt');

function resultBytes(result) {
  return Buffer.byteLength(JSON.stringify(result), 'utf8');
}

async function readUsage() {
  return JSON.parse(await fs.readFile(usageFile, 'utf8'));
}

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
      DESKTOP_COMMANDER_USAGE_FILE: usageFile,
    },
  });

  const client = new Client(
    { name: 'desktop-commander-usage-test', version: '1.0.0' },
    { capabilities: {} },
  );
  await client.connect(transport, { timeout: 30000 });
  return client;
}

try {
  await fs.writeFile(testFile, 'alpha\nbeta\ngamma\n', 'utf8');
  await fs.writeFile(policyFile, JSON.stringify({
    version: 1,
    tier: 'free',
    rules: [],
  }));
  const client = await createClient();
  try {
    const readResult = await client.callTool({
      name: 'read_file',
      arguments: { path: testFile, offset: 0, length: 2 },
    });

    let expectedReturned = resultBytes(readResult);
    let usage = await readUsage();
    assert.strictEqual(usage.returnedBytes, expectedReturned);
    assert.strictEqual(usage.writtenBytes, 0);
    assert.ok(!Number.isNaN(Date.parse(usage.periodStartedAt)));

    const secondClient = await createClient();
    try {
      const [parallelA, parallelB] = await Promise.all([
        client.callTool({
          name: 'read_file',
          arguments: { path: testFile, offset: 0, length: 1 },
        }),
        secondClient.callTool({
          name: 'read_file',
          arguments: { path: testFile, offset: 1, length: 1 },
        }),
      ]);
      expectedReturned += resultBytes(parallelA) + resultBytes(parallelB);
      usage = await readUsage();
      assert.strictEqual(
        usage.returnedBytes,
        expectedReturned,
        'Concurrent MCP server processes must not lose usage increments',
      );
    } finally {
      await secondClient.close();
    }

    const beforeUiWritten = usage.writtenBytes;
    const uiResult = await client.callTool({
      name: 'read_file',
      arguments: { path: testFile, offset: 0, length: 1, origin: 'ui' },
    });
    assert.ok(!uiResult.isError);
    expectedReturned += resultBytes(uiResult);
    usage = await readUsage();
    assert.strictEqual(
      usage.returnedBytes,
      expectedReturned,
      'Client-controlled origin must not bypass usage metering',
    );
    assert.strictEqual(usage.writtenBytes, beforeUiWritten);

    const content = 'written € payload';
    const writeResult = await client.callTool({
      name: 'write_file',
      arguments: { path: testFile, content, mode: 'rewrite' },
    });
    assert.ok(!writeResult.isError);
    expectedReturned += resultBytes(writeResult);
    usage = await readUsage();
    assert.strictEqual(usage.returnedBytes, expectedReturned);
    assert.strictEqual(
      usage.writtenBytes,
      Buffer.byteLength(content, 'utf8'),
    );

    await fs.writeFile(policyFile, JSON.stringify({
      version: 1,
      tier: 'pro',
      rules: [{
        id: 'metering-protected-write',
        action: 'filesystem.write',
        resourcePrefix: tempDir,
        decision: 'require_approval',
      }],
    }));

    const blockedContent = 'must not count as written';
    const blocked = await client.callTool({
      name: 'write_file',
      arguments: { path: testFile, content: blockedContent, mode: 'rewrite' },
    });
    assert.strictEqual(blocked.isError, true);
    expectedReturned += resultBytes(blocked);
    usage = await readUsage();
    assert.strictEqual(usage.returnedBytes, expectedReturned);
    assert.strictEqual(
      usage.writtenBytes,
      Buffer.byteLength(content, 'utf8'),
      'Approval-required payload must not count as written',
    );
    assert.strictEqual(await fs.readFile(testFile, 'utf8'), content);

    const raw = await fs.readFile(usageFile, 'utf8');
    assert.ok(!raw.includes(content));
    assert.ok(!raw.includes(blockedContent));

    await fs.writeFile(usageFile, '{ corrupt usage state', 'utf8');
    const resilient = await client.callTool({
      name: 'read_file',
      arguments: { path: testFile, offset: 0, length: 1 },
    });
    assert.ok(!resilient.isError, 'Meter failure must not break Desktop Commander');

    console.log('✅ Real MCP usage metering integration test passed');
  } finally {
    await client.close();
  }
} finally {
  await fs.rm(tempDir, { recursive: true, force: true });
}
