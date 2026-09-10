/** Real MCP proof for low-overhead progress enforcement. */
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(here, '..', '..');
const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'dc-progress-enforce-mcp-'));
const repo = path.join(tempDir, 'repo');
const stateRoot = path.join(tempDir, 'state');
const policyFile = path.join(tempDir, 'policy.json');

function git(...args) {
  return execFileSync('git', ['-C', repo, ...args], { encoding: 'utf8' }).trim();
}
function text(result) {
  return result?.content?.find?.((item) => item.type === 'text')?.text ?? '';
}
async function exists(target) {
  return fs.stat(target).then(() => true, () => false);
}
try {
  await fs.mkdir(path.join(repo, '.desktop-commander'), { recursive: true });
  await fs.writeFile(path.join(repo, '.desktop-commander', 'project-workflow.json'), JSON.stringify({
    version: 1,
    id: 'progress-enforcement-integration',
    name: 'Progress enforcement integration',
    stages: [
      { id: 'implement', label: 'Implement', required: true },
      { id: 'verify', label: 'Verify', required: true },
    ],
  }, null, 2));
  execFileSync('git', ['init', repo]);
  git('config', 'user.email', 'test@example.invalid');
  git('config', 'user.name', 'Progress Enforcement Integration');
  await fs.writeFile(path.join(repo, 'README.md'), '# Progress enforcement\n');
  git('add', '.');
  git('commit', '-m', 'baseline');

  await fs.writeFile(policyFile, JSON.stringify({
    version: 1,
    tier: 'pro',
    rules: [{
      id: 'approval-after-progress',
      action: 'filesystem.write',
      resourcePrefix: repo,
      decision: 'require_approval',
    }],
  }));
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [path.join(projectRoot, 'dist/index.js'), '--no-onboarding'],
    cwd: projectRoot,
    stderr: 'pipe',
    env: {
      ...process.env,
      DESKTOP_COMMANDER_DISABLE_TELEMETRY: 'true',
      DESKTOP_COMMANDER_POLICY_FILE: policyFile,
      DESKTOP_COMMANDER_WORKFLOW_STATE_DIR: stateRoot,
    },
  });
  const client = new Client(
    { name: 'progress-enforcement-integration', version: '1.0.0' },
    { capabilities: {} },
  );
  await client.connect(transport, { timeout: 30000 });

  try {
    const listed = await client.listTools();
    const progressTool = listed.tools.find((tool) => tool.name === 'report_task_progress');
    assert.ok(progressTool);
    assert.equal(progressTool.annotations?.readOnlyHint, false);

    const registered = await client.callTool({
      name: 'active_work_registry',
      arguments: {
        action: 'register', projectRoot: repo, title: 'Progress enforcement proof',
        scope: 'Prove Free progress gate precedes side effects', affectedAreas: ['.'],
      },
    });
    assert.equal(registered.structuredContent?.registered, true);
    const entryId = registered.structuredContent?.entry?.id;
    assert.ok(entryId);

    const started = await client.callTool({
      name: 'project_workflow',
      arguments: { action: 'start', projectRoot: repo, goal: 'Prove enforced progress reporting' },
    });
    assert.ok(!started.isError, text(started));

    const completed = await client.callTool({
      name: 'project_workflow',
      arguments: {
        action: 'record', projectRoot: repo, stageId: 'implement', status: 'completed',
        evidence: { kind: 'agent_attestation', summary: 'Implementation complete in integration test' },
      },
    });
    assert.ok(!completed.isError, text(completed));

    const waiting = await client.callTool({
      name: 'project_workflow',
      arguments: {
        action: 'record', projectRoot: repo, stageId: 'verify', status: 'waiting_external',
        reason: 'External verification is still running',
      },
    });
    assert.ok(!waiting.isError, text(waiting));

    const target = path.join(repo, 'protected.txt');
    const blocked = await client.callTool({
      name: 'write_file',
      arguments: { path: target, content: 'write-after-progress', mode: 'rewrite' },
    });
    assert.equal(blocked.isError, true);
    assert.match(text(blocked), /PROGRESS_REPORT_REQUIRED/);
    assert.equal(await exists(target), false);

    const report = await client.callTool({
      name: 'report_task_progress',
      arguments: {
        projectRoot: repo,
        percentRemaining: 99,
        currentPhase: 'caller-supplied-fake-phase',
        estimatedRemainingMinutes: 25,
      },
    });
    assert.ok(!report.isError, text(report));
    const progress = JSON.parse(text(report));
    assert.equal(progress.percentRemaining, 50);
    assert.equal(progress.percentComplete, 50);
    assert.equal('estimatedRemainingMinutes' in progress, false);
    assert.equal('estimatedRemainingText' in progress, false);
    assert.equal(progress.tier, 'free');
    assert.doesNotMatch(progress.currentPhase, /fake/i);

    const freeWrite = await client.callTool({
      name: 'write_file',
      arguments: { path: target, content: 'write-after-progress', mode: 'rewrite' },
    });
    assert.ok(!freeWrite.isError, text(freeWrite));
    assert.doesNotMatch(text(freeWrite), /Approval required/i);
    assert.equal(await fs.readFile(target, 'utf8'), 'write-after-progress');

    await client.callTool({
      name: 'active_work_registry',
      arguments: { action: 'remove', projectRoot: repo, entryId },
    });
    console.log('✅ Real MCP progress enforcement integration passed');
  } finally {
    await client.close().catch(() => undefined);
  }
} finally {
  await fs.rm(tempDir, { recursive: true, force: true });
}
