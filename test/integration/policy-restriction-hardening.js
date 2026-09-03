/**
 * Real MCP regression coverage for restriction-bypass hardening.
 */
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

const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'dc-restriction-hardening-'));
const policyFile = path.join(tempDir, 'policy.json');
const approvalFile = path.join(tempDir, 'approvals.json');
const stateRoot = path.join(tempDir, 'workflow-state');

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
      DESKTOP_COMMANDER_WORKFLOW_STATE_DIR: stateRoot,
    },
  });

  const client = new Client(
    { name: 'desktop-commander-restriction-hardening-test', version: '1.0.0' },
    { capabilities: {} }
  );
  await client.connect(transport, { timeout: 30000 });
  return client;
}

async function exists(filePath) {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}
try {
  const broad = path.join(tempDir, 'projects');
  const allowed = path.join(broad, 'allowed');
  const blocked = path.join(broad, 'blocked');
  const link = path.join(allowed, 'link-to-blocked');
  const markerFile = path.join(tempDir, 'wrapper-marker.txt');

  await fs.mkdir(allowed, { recursive: true });
  await fs.mkdir(blocked, { recursive: true });
  await fs.writeFile(path.join(blocked, 'secret.txt'), 'secret');
  await fs.symlink(
    blocked,
    link,
    process.platform === 'win32' ? 'junction' : 'dir'
  );

  await fs.writeFile(policyFile, JSON.stringify({
    version: 1,
    tier: 'pro',
    profile: 'full_access',
    rules: [
      { id: 'block-echo', action: 'terminal.execute', commandPrefix: 'echo', decision: 'deny' },
      { id: 'block-read', action: 'filesystem.read', resourcePrefix: broad, decision: 'deny' },
      { id: 'block-write', action: 'filesystem.write', resourcePrefix: broad, decision: 'deny' },
      { id: 'allow-read', action: 'filesystem.read', resourcePrefix: allowed, decision: 'allow' },
      { id: 'allow-write', action: 'filesystem.write', resourcePrefix: allowed, decision: 'allow' },
    ],
  }));

  const client = await createClient();

  try {
    const wrappedCommand = process.platform === 'win32'
      ? `cmd.exe /d /s /c "echo WRAPPER_BYPASS > ${markerFile}"`
      : `sh -c "echo WRAPPER_BYPASS > ${markerFile}"`;

    const wrapped = await client.callTool({
      name: 'start_process',
      arguments: { command: wrappedCommand, timeout_ms: 5000 },
    });
    assert.strictEqual(wrapped.isError, true, 'Wrapped blocked command must be denied');
    assert.strictEqual(
      await exists(markerFile),
      false,
      'Denied wrapped command must not create its marker'
    );

    const escapedRead = await client.callTool({
      name: 'read_file',
      arguments: { path: path.join(link, 'secret.txt') },
    });
    assert.strictEqual(
      escapedRead.isError,
      true,
      'Junction/symlink read must be evaluated against its canonical target'
    );

    const escapedWritePath = path.join(link, 'created.txt');
    const escapedWrite = await client.callTool({
      name: 'write_file',
      arguments: { path: escapedWritePath, content: 'escape', mode: 'rewrite' },
    });
    assert.strictEqual(
      escapedWrite.isError,
      true,
      'Junction/symlink write must be evaluated against its canonical target'
    );
    assert.strictEqual(
      await exists(path.join(blocked, 'created.txt')),
      false,
      'Denied junction/symlink write must have no side effect'
    );

    const repo = path.join(tempDir, 'repo');
    const workflowDir = path.join(repo, '.desktop-commander');
    await fs.mkdir(workflowDir, { recursive: true });
    await fs.writeFile(
      path.join(workflowDir, 'project-workflow.json'),
      JSON.stringify({
        version: 1,
        id: 'read-only-hardening',
        name: 'Read only hardening',
        stages: [{ id: 'inspect', label: 'Inspect', required: true }],
      })
    );
    execFileSync('git', ['init', repo], { stdio: 'ignore' });
    execFileSync('git', ['-C', repo, 'config', 'user.email', 'test@example.invalid']);
    execFileSync('git', ['-C', repo, 'config', 'user.name', 'Restriction Hardening']);
    await fs.writeFile(path.join(repo, 'README.md'), '# Test\n');
    execFileSync('git', ['-C', repo, 'add', '.']);
    execFileSync('git', ['-C', repo, 'commit', '-m', 'baseline'], { stdio: 'ignore' });

    await fs.writeFile(policyFile, JSON.stringify({
      version: 1,
      tier: 'pro',
      profile: 'read_only',
      rules: [],
    }));

    const workflowStart = await client.callTool({
      name: 'project_workflow',
      arguments: {
        action: 'start',
        projectRoot: repo,
        goal: 'Must be denied by Read Only',
      },
    });
    assert.strictEqual(
      workflowStart.isError,
      true,
      'Read Only must deny project_workflow mutations before state is created'
    );
    assert.strictEqual(
      await exists(stateRoot),
      false,
      'Denied workflow start must not create authoritative workflow state'
    );

    const stopSearch = await client.callTool({
      name: 'stop_search',
      arguments: { sessionId: 'does-not-exist' },
    });
    assert.strictEqual(
      stopSearch.isError,
      true,
      'Read Only must deny stop_search before handler execution'
    );

    const feedback = await client.callTool({
      name: 'give_feedback_to_desktop_commander',
      arguments: {},
    });
    assert.strictEqual(
      feedback.isError,
      true,
      'Read Only must deny browser-opening feedback action'
    );

    console.log('✅ Restriction-bypass hardening real MCP integration test passed');
  } finally {
    await client.close();
  }
} finally {
  await fs.rm(tempDir, { recursive: true, force: true });
}
