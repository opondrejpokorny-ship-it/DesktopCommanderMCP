/**
 * Real MCP integration coverage for the native active work registry.
 */
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
const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'dc-active-work-mcp-'));
const repoA = path.join(tempDir, 'repo-a');
const repoB = path.join(tempDir, 'repo-b');
const stateRoot = path.join(tempDir, 'state');
const policyFile = path.join(tempDir, 'policy.json');
const approvalFile = path.join(tempDir, 'approvals.json');

function git(cwd, ...args) {
  return execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8' }).trim();
}

function makeTransport() {
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
  await fs.mkdir(repoA, { recursive: true });
  execFileSync('git', ['init', repoA]);
  git(repoA, 'config', 'user.email', 'test@example.invalid');
  git(repoA, 'config', 'user.name', 'Active Work MCP');
  await fs.writeFile(path.join(repoA, 'README.md'), '# MCP Registry\n');
  git(repoA, 'add', '.');
  git(repoA, 'commit', '-m', 'baseline');
  git(repoA, 'remote', 'add', 'origin', 'https://github.com/example/mcp-registry.git');
  git(repoA, 'worktree', 'add', '-b', 'worker-b', repoB);
  await fs.writeFile(policyFile, JSON.stringify({ version: 1, tier: 'free', rules: [] }));

  let client = new Client(
    { name: 'active-work-registry-test', version: '1.0.0' },
    { capabilities: {} },
  );
  await client.connect(makeTransport(), { timeout: 30000 });

  try {
    assert.match(client.getInstructions() ?? '', /active_work_registry/);

    const tools = await client.listTools();
    assert.ok(
      tools.tools.some((tool) => tool.name === 'active_work_registry'),
      'active_work_registry must be exposed through MCP tools/list',
    );

    const registered = await client.callTool({
      name: 'active_work_registry',
      arguments: {
        action: 'register',
        projectRoot: repoA,
        title: 'Protected workflow change',
        scope: 'Change a workflow control-plane component',
        affectedAreas: ['src/workflow/example.ts'],
        riskAreas: ['workflow-control-plane'],
        target: 'prototype/free-pro-team',
        nextAction: 'Run focused tests',
      },
    });
    assert.ok(!registered.isError, JSON.stringify(registered));
    assert.equal(registered.structuredContent?.registered, true);

    const overlap = await client.callTool({
      name: 'active_work_registry',
      arguments: {
        action: 'check',
        projectRoot: repoB,
        title: 'Different workflow change',
        scope: 'A second task in the same area',
        affectedAreas: ['src/workflow'],
        riskAreas: ['workflow-control-plane'],
      },
    });
    assert.ok(!overlap.isError, JSON.stringify(overlap));
    assert.equal(overlap.structuredContent?.guidance, 'wait_or_read_only');

    const safe = await client.callTool({
      name: 'active_work_registry',
      arguments: {
        action: 'check',
        projectRoot: repoB,
        title: 'Independent docs work',
        scope: 'Edit unrelated docs',
        affectedAreas: ['docs/independent.md'],
      },
    });
    assert.equal(safe.structuredContent?.guidance, 'safe_parallel');

    const listed = await client.callTool({
      name: 'active_work_registry',
      arguments: { action: 'list', projectRoot: repoB },
    });
    assert.ok(!listed.isError);
    assert.equal(listed.structuredContent?.entries?.length, 1);

    const registryPath = path.join(stateRoot, 'active-work-registry.json');
    const beforeTamper = await fs.readFile(registryPath, 'utf8');
    const tamper = await client.callTool({
      name: 'write_file',
      arguments: { path: registryPath, content: 'tamper', mode: 'rewrite' },
    });
    assert.equal(tamper.isError, true);
    assert.match(tamper.content?.[0]?.text ?? '', /project-workflow-control-plane/i);
    assert.equal(await fs.readFile(registryPath, 'utf8'), beforeTamper);
  } finally {
    await client.close();
  }

  client = new Client(
    { name: 'active-work-registry-restart-test', version: '1.0.0' },
    { capabilities: {} },
  );
  await client.connect(makeTransport(), { timeout: 30000 });
  try {
    const afterRestart = await client.callTool({
      name: 'active_work_registry',
      arguments: { action: 'list', projectRoot: repoB },
    });
    assert.ok(!afterRestart.isError);
    assert.equal(
      afterRestart.structuredContent?.entries?.length,
      1,
      'registry must persist across a real MCP server restart',
    );
  } finally {
    await client.close();
  }

  console.log('✅ Real MCP active work registry integration passed');
} finally {
  await fs.rm(tempDir, { recursive: true, force: true });
}
