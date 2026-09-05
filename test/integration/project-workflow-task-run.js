import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import assert from 'node:assert';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = path.resolve(__dirname, '..', '..');
const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'dc-b4-mcp-'));
const repo = path.join(tempDir, 'repo');
const stateRoot = path.join(tempDir, 'state');
const profileDir = path.join(repo, '.desktop-commander');
const policyFile = path.join(tempDir, 'policy.json');

function git(...args) {
  return execFileSync('git', ['-C', repo, ...args], { encoding: 'utf8' }).trim();
}

try {
  await fs.mkdir(profileDir, { recursive: true });
  await fs.writeFile(path.join(profileDir, 'project-workflow.json'), JSON.stringify({
    version: 1,
    id: 'b4-mcp',
    name: 'B4 MCP',
    stages: [{ id: 'verify', label: 'Verify', required: true }]
  }));
  await fs.writeFile(policyFile, JSON.stringify({ version: 1, tier: 'free', rules: [] }));
  execFileSync('git', ['init', repo]);
  git('config', 'user.email', 'test@example.invalid');
  git('config', 'user.name', 'B4 MCP');
  await fs.writeFile(path.join(repo, 'README.md'), '# B4 MCP\n');
  git('add', '.');
  git('commit', '-m', 'baseline');

  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [path.join(PROJECT_ROOT, 'dist/index.js'), '--no-onboarding'],
    cwd: PROJECT_ROOT,
    stderr: 'pipe',
    env: {
      ...process.env,
      DESKTOP_COMMANDER_DISABLE_TELEMETRY: 'true',
      DESKTOP_COMMANDER_POLICY_FILE: policyFile,
      DESKTOP_COMMANDER_WORKFLOW_STATE_DIR: stateRoot,
    },
  });
  const client = new Client({ name: 'b4-task-run', version: '1.0.0' }, { capabilities: {} });
  await client.connect(transport, { timeout: 30000 });

  try {
    const started = await client.callTool({ name: 'project_workflow', arguments: {
      action: 'start', projectRoot: repo, goal: 'B4 real MCP',
      taskId: 'attacker-task', runId: 'attacker-run'
    }});
    assert.ok(!started.isError, JSON.stringify(started));
    const first = started.structuredContent;
    assert.strictEqual(first.workflowId, first.taskId);
    assert.notStrictEqual(first.taskId, 'attacker-task');
    assert.notStrictEqual(first.runId, 'attacker-run');

    const status = await client.callTool({ name: 'project_workflow', arguments: {
      action: 'status', projectRoot: repo,
      taskId: 'attacker-task-2', runId: 'attacker-run-2'
    }});
    assert.ok(!status.isError, JSON.stringify(status));
    assert.strictEqual(status.structuredContent.taskId, first.taskId);
    assert.strictEqual(status.structuredContent.runId, first.runId);

    const resumed = await client.callTool({ name: 'project_workflow', arguments: {
      action: 'resume', projectRoot: repo,
      taskId: 'attacker-task-3', runId: 'attacker-run-3'
    }});
    assert.ok(!resumed.isError, JSON.stringify(resumed));
    assert.strictEqual(resumed.structuredContent.taskId, first.taskId);
    assert.strictEqual(resumed.structuredContent.workflowId, first.workflowId);
    assert.notStrictEqual(resumed.structuredContent.runId, first.runId);
    assert.notStrictEqual(resumed.structuredContent.runId, 'attacker-run-3');

    console.log('✅ Real MCP Scope B4 Task/Run authority test passed');
  } finally {
    await client.close();
  }
} finally {
  await fs.rm(tempDir, { recursive: true, force: true });
}
