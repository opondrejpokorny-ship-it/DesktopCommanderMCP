/** Real MCP restart coverage for automatic operational memory. */
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import assert from 'node:assert';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const PROJECT_ROOT = path.resolve(__dirname, '..', '..');
const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'dc-memory-restart-'));
const repo = path.join(tempDir, 'repo');
const stateRoot = path.join(tempDir, 'state');
const policyFile = path.join(tempDir, 'policy.json');
const approvalFile = path.join(tempDir, 'approvals.json');
const usageFile = path.join(tempDir, 'usage.json');

function git(...args) {
  return execFileSync('git', ['-C', repo, ...args], { encoding: 'utf8' }).trim();
}
async function connect() {
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
      DESKTOP_COMMANDER_WORKFLOW_STATE_DIR: stateRoot,
      DESKTOP_COMMANDER_USAGE_METER_FILE: usageFile,
    },
  });
  const client = new Client(
    { name: 'operational-memory-restart-test', version: '1.0.0' },
    { capabilities: {} },
  );
  await client.connect(transport, { timeout: 30000 });
  return client;
}

function memoryOf(result) {
  return result.structuredContent?.operationalMemory;
}
try {
  await fs.mkdir(path.join(repo, '.desktop-commander'), { recursive: true });
  await fs.writeFile(
    path.join(repo, '.desktop-commander', 'project-workflow.json'),
    JSON.stringify({
      version: 1,
      id: 'memory-restart',
      name: 'Memory restart',
      stages: [{ id: 'inspect', label: 'Inspect', required: true }],
    }, null, 2),
  );
  await fs.writeFile(policyFile, JSON.stringify({ version: 1, tier: 'free', rules: [] }));

  execFileSync('git', ['init', repo]);
  git('config', 'user.email', 'test@example.invalid');
  git('config', 'user.name', 'Operational Memory Restart');
  await fs.writeFile(path.join(repo, 'README.md'), '# restart test\n');
  git('add', '.');
  git('commit', '-m', 'baseline');

  const missingPath = path.join(repo, 'sk-super-secret-raw-marker.txt');
  const first = await connect();
  try {
    const started = await first.callTool({
      name: 'project_workflow',
      arguments: {
        action: 'start',
        projectRoot: repo,
        goal: 'Remember a failed read across process restart',
      },
    });
    assert.ok(!started.isError, JSON.stringify(started));

    const failed = await first.callTool({
      name: 'read_file',
      arguments: { path: missingPath },
    });
    assert.strictEqual(failed.isError, true);
  } finally {
    await first.close();
  }

  const second = await connect();
  try {
    const resumed = await second.callTool({
      name: 'project_workflow',
      arguments: { action: 'resume', projectRoot: repo },
    });
    assert.ok(!resumed.isError, JSON.stringify(resumed));
    let memory = memoryOf(resumed);
    assert.strictEqual(memory.totalEvents, 1);
    assert.strictEqual(memory.uniqueLessons, 1);
    assert.strictEqual(memory.lessons[0].reasonCode, 'not_found');
    assert.strictEqual(memory.lessons[0].occurrences, 1);
    assert.match(
      resumed.content?.[0]?.text ?? '',
      /Re-check the resource path and current state before retrying/i,
    );

    const failedAgain = await second.callTool({
      name: 'read_file',
      arguments: { path: missingPath },
    });
    assert.strictEqual(failedAgain.isError, true);

    const resumedAgain = await second.callTool({
      name: 'project_workflow',
      arguments: { action: 'resume', projectRoot: repo },
    });
    memory = memoryOf(resumedAgain);
    assert.strictEqual(memory.totalEvents, 2);
    assert.strictEqual(memory.uniqueLessons, 1);
    assert.strictEqual(memory.lessons[0].occurrences, 2);
  } finally {
    await second.close();
  }

  const memoryFiles = (await fs.readdir(stateRoot))
    .filter((name) => name.endsWith('.memory.jsonl'));
  assert.strictEqual(memoryFiles.length, 1);
  const persisted = await fs.readFile(path.join(stateRoot, memoryFiles[0]), 'utf8');
  assert.strictEqual(persisted.trim().split(/\r?\n/).length, 2);
  assert.ok(!persisted.includes('sk-super-secret-raw-marker'));
  assert.ok(!persisted.includes(repo));
  assert.match(persisted, /requested resource was not found/i);

  console.log('✅ Real MCP operational memory restart test passed');
} finally {
  await fs.rm(tempDir, { recursive: true, force: true });
}
