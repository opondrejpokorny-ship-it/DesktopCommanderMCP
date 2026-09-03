/**
 * Real MCP stdio integration test for tier-aware lifecycle progress reporting.
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

const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'dc-progress-integration-'));
const policyFile = path.join(tempDir, 'policy.json');

function firstText(result) {
  return result?.content?.find?.((entry) => entry.type === 'text')?.text ?? '';
}

async function setTier(tier) {
  await fs.writeFile(policyFile, JSON.stringify({
    version: 1,
    tier,
    rules: [],
  }));
}

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
  { name: 'desktop-commander-progress-test', version: '1.0.0' },
  { capabilities: {} }
);

try {
  await setTier('free');
  await client.connect(transport, { timeout: 30000 });

  const listed = await client.listTools();
  assert.ok(
    listed.tools.some((tool) => tool.name === 'report_task_progress'),
    'Real MCP tools/list must expose report_task_progress'
  );

  const args = {
    percentRemaining: 40,
    currentPhase: 'verification',
    estimatedRemainingMinutes: 25,
  };

  const freeResult = await client.callTool({
    name: 'report_task_progress',
    arguments: args,
  });
  assert.ok(!freeResult.isError);
  const free = JSON.parse(firstText(freeResult));
  assert.strictEqual(free.tier, 'free');
  assert.strictEqual(free.percentRemaining, 40);
  assert.strictEqual(free.percentComplete, 60);
  assert.ok(!('estimatedRemainingMinutes' in free));
  assert.ok(!('estimatedRemainingText' in free));
  assert.doesNotMatch(free.message, /25 min|estimated time/i);

  for (const tier of ['pro', 'team']) {
    await setTier(tier);
    const paidResult = await client.callTool({
      name: 'report_task_progress',
      arguments: args,
    });
    assert.ok(!paidResult.isError);
    const paid = JSON.parse(firstText(paidResult));
    assert.strictEqual(paid.tier, tier);
    assert.strictEqual(paid.percentRemaining, 40);
    assert.strictEqual(paid.estimatedRemainingMinutes, 25);
    assert.strictEqual(paid.estimatedRemainingText, 'about 25 min');
    assert.match(paid.message, /estimated time remaining.*25 min/i);
  }

  console.log('✅ Real MCP tier-aware progress integration test passed');
} finally {
  await client.close().catch(() => undefined);
  await fs.rm(tempDir, { recursive: true, force: true });
}
