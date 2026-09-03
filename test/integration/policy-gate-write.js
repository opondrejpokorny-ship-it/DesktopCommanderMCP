/**
 * End-to-end integration test for the prototype access-control gate.
 *
 * Drives the real built MCP server over stdio, exactly like an AI client.
 * It proves that a protected write is stopped before the existing write_file
 * handler mutates the filesystem.
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

const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'dc-policy-integration-'));
const testFile = path.join(tempDir, 'protected.txt');
const policyFile = path.join(tempDir, 'policy.json');

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
    const blocked = await client.callTool({
      name: 'write_file',
      arguments: {
        path: testFile,
        content: 'should-not-be-written',
        mode: 'rewrite',
      },
    });

    assert.strictEqual(blocked.isError, true, 'Protected write should be stopped');
    assert.match(firstText(blocked), /Approval required/i);
    assert.match(firstText(blocked), /No action was executed/i);
    assert.strictEqual(
      await fs.readFile(testFile, 'utf8'),
      'original',
      'The real file must remain unchanged when approval is required'
    );

    // Same running MCP server, policy changed to Free. The runtime intentionally
    // reloads policy so future Control Center changes can take effect immediately.
    await fs.writeFile(policyFile, JSON.stringify({
      version: 1,
      tier: 'free',
      rules: [],
    }));

    const allowed = await client.callTool({
      name: 'write_file',
      arguments: {
        path: testFile,
        content: 'allowed-change',
        mode: 'rewrite',
      },
    });

    assert.ok(!allowed.isError, 'Free write should continue to upstream handler');
    assert.strictEqual(
      await fs.readFile(testFile, 'utf8'),
      'allowed-change',
      'Allowed request should preserve normal Desktop Commander write behavior'
    );

    console.log('✅ Real MCP write policy integration test passed');
  } finally {
    await client.close();
  }
} finally {
  await fs.rm(tempDir, { recursive: true, force: true });
}
