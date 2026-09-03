/**
 * Real MCP integration coverage for the project workflow coordinator.
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

const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'dc-project-workflow-mcp-'));
const repo = path.join(tempDir, 'repo');
const stateRoot = path.join(tempDir, 'state');
const profileDir = path.join(repo, '.desktop-commander');
const profilePath = path.join(profileDir, 'project-workflow.json');
const policyFile = path.join(tempDir, 'policy.json');
const approvalFile = path.join(tempDir, 'approvals.json');

function git(...args) {
  return execFileSync('git', ['-C', repo, ...args], { encoding: 'utf8' }).trim();
}
try {
  await fs.mkdir(profileDir, { recursive: true });
  await fs.writeFile(profilePath, JSON.stringify({
    version: 1,
    id: 'mcp-project',
    name: 'MCP project',
    stages: [
      { id: 'inspect', label: 'Inspect', required: true },
      { id: 'verify', label: 'Verify', required: true },
      { id: 'deploy', label: 'Deploy', required: false, authorizationRequired: true }
    ]
  }, null, 2));
  await fs.writeFile(policyFile, JSON.stringify({ version: 1, tier: 'free', rules: [] }));

  execFileSync('git', ['init', repo]);
  git('config', 'user.email', 'test@example.invalid');
  git('config', 'user.name', 'Workflow Integration');
  await fs.writeFile(path.join(repo, 'README.md'), '# Integration\n');
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
      DESKTOP_COMMANDER_APPROVAL_FILE: approvalFile,
      DESKTOP_COMMANDER_WORKFLOW_STATE_DIR: stateRoot,
    },
  });
  const client = new Client(
    { name: 'desktop-commander-project-workflow-test', version: '1.0.0' },
    { capabilities: {} },
  );
  await client.connect(transport, { timeout: 30000 });

  try {
    assert.match(client.getInstructions() ?? '', /project_workflow/);
    assert.match(client.getInstructions() ?? '', /explicit user authorization/i);

    const toolsResult = await client.listTools();
    const workflowTool = toolsResult.tools.find((tool) => tool.name === 'project_workflow');
    assert.ok(workflowTool, 'project_workflow must be exposed through MCP tools/list');
    const started = await client.callTool({
      name: 'project_workflow',
      arguments: {
        action: 'start',
        projectRoot: repo,
        goal: 'Prove real MCP workflow execution'
      },
    });
    assert.ok(!started.isError, JSON.stringify(started));
    assert.match(started.content?.[0]?.text ?? '', /0% complete/i);
    assert.match(started.content?.[0]?.text ?? '', /inspect/i);

    const statePath = started.structuredContent?.statePath;
    assert.ok(typeof statePath === 'string' && statePath.startsWith(path.resolve(stateRoot)));

    const tamperState = await client.callTool({
      name: 'write_file',
      arguments: { path: statePath, content: 'tamper', mode: 'rewrite' },
    });
    assert.strictEqual(tamperState.isError, true);
    assert.match(tamperState.content?.[0]?.text ?? '', /project-workflow-control-plane/i);

    const tamperProfile = await client.callTool({
      name: 'write_file',
      arguments: { path: profilePath, content: 'tamper', mode: 'rewrite' },
    });
    assert.strictEqual(tamperProfile.isError, true);
    assert.strictEqual(
      JSON.parse(await fs.readFile(profilePath, 'utf8')).id,
      'mcp-project',
      'policy gate must prevent actual profile modification',
    );

    const inspect = await client.callTool({
      name: 'project_workflow',
      arguments: {
        action: 'record',
        projectRoot: repo,
        stageId: 'inspect',
        status: 'completed',
        evidence: {
          kind: 'agent_attestation',
          summary: 'Repository and current branch inspected.'
        }
      },
    });
    assert.ok(!inspect.isError);
    assert.match(inspect.content?.[0]?.text ?? '', /33% complete/i);
    const deployWithoutAuth = await client.callTool({
      name: 'project_workflow',
      arguments: {
        action: 'record',
        projectRoot: repo,
        stageId: 'deploy',
        status: 'completed',
        evidence: {
          kind: 'provider_reference',
          summary: 'No user authorization exists.'
        }
      },
    });
    assert.strictEqual(deployWithoutAuth.isError, true);
    assert.match(deployWithoutAuth.content?.[0]?.text ?? '', /authorization/i);

    const deployWithSelfAttestedUserAuth = await client.callTool({
      name: 'project_workflow',
      arguments: {
        action: 'record',
        projectRoot: repo,
        stageId: 'deploy',
        status: 'completed',
        evidence: {
          kind: 'user_authorization',
          summary: 'Agent claims the user approved deployment.'
        }
      },
    });
    assert.strictEqual(deployWithSelfAttestedUserAuth.isError, true);
    assert.match(
      deployWithSelfAttestedUserAuth.content?.[0]?.text ?? '',
      /authorization|invalid/i
    );
    const verify = await client.callTool({
      name: 'project_workflow',
      arguments: {
        action: 'record',
        projectRoot: repo,
        stageId: 'verify',
        status: 'completed',
        evidence: {
          kind: 'agent_attestation',
          summary: 'Real MCP verification passed.'
        }
      },
    });
    assert.ok(!verify.isError);

    const skipDeploy = await client.callTool({
      name: 'project_workflow',
      arguments: {
        action: 'record',
        projectRoot: repo,
        stageId: 'deploy',
        status: 'skipped',
        reason: 'No deploy authorization was requested.'
      },
    });
    assert.ok(!skipDeploy.isError);

    const finished = await client.callTool({
      name: 'project_workflow',
      arguments: { action: 'finish', projectRoot: repo },
    });
    assert.ok(!finished.isError, JSON.stringify(finished));
    assert.match(finished.content?.[0]?.text ?? '', /100% complete/i);
    assert.match(finished.content?.[0]?.text ?? '', /workflow complete/i);

    console.log('✅ Real MCP project workflow integration test passed');
  } finally {
    await client.close();
  }
} finally {
  await fs.rm(tempDir, { recursive: true, force: true });
}
