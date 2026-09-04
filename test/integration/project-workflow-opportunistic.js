/**
 * Real MCP integration for opportunistic project-workflow scheduling.
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

const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'dc-project-workflow-opportunistic-mcp-'));
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
    id: 'mcp-opportunistic-project',
    name: 'MCP opportunistic project',
    stages: [
      { id: 'inspect', label: 'Inspect', required: true, workMode: 'read_only' },
      { id: 'ci', label: 'CI', required: true, dependsOn: ['inspect'] },
      {
        id: 'readiness-audit',
        label: 'Read-only readiness audit',
        required: true,
        dependsOn: ['inspect'],
        workMode: 'read_only',
        evidenceScope: 'git_head'
      },
      {
        id: 'write-followup',
        label: 'Write follow-up',
        required: false,
        dependsOn: ['inspect'],
        workMode: 'side_effecting'
      }
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
    { name: 'desktop-commander-opportunistic-workflow-test', version: '1.0.0' },
    { capabilities: {} },
  );
  await client.connect(transport, { timeout: 30000 });

  try {
    assert.match(client.getInstructions() ?? '', /waiting_external/);
    assert.match(client.getInstructions() ?? '', /recommendedStage/);
    assert.match(client.getInstructions() ?? '', /read-only work/i);

    const started = await client.callTool({
      name: 'project_workflow',
      arguments: {
        action: 'start',
        projectRoot: repo,
        goal: 'Use CI wait time for a planned readiness audit'
      }
    });
    assert.ok(!started.isError, JSON.stringify(started));
    assert.strictEqual(started.structuredContent?.recommendedStage?.id, 'inspect');

    const inspected = await client.callTool({
      name: 'project_workflow',
      arguments: {
        action: 'record',
        projectRoot: repo,
        stageId: 'inspect',
        status: 'completed',
        evidence: {
          kind: 'agent_attestation',
          summary: 'Repository inspected.'
        }
      }
    });
    assert.ok(!inspected.isError);

    const waiting = await client.callTool({
      name: 'project_workflow',
      arguments: {
        action: 'record',
        projectRoot: repo,
        stageId: 'ci',
        status: 'waiting_external',
        reason: 'GitHub Actions is still running.'
      }
    });
    assert.ok(!waiting.isError, JSON.stringify(waiting));
    assert.strictEqual(waiting.structuredContent?.nextStage?.id, 'ci');
    assert.strictEqual(waiting.structuredContent?.recommendedStage?.id, 'readiness-audit');
    assert.deepStrictEqual(
      waiting.structuredContent?.opportunisticStages?.map((stage) => stage.id),
      ['readiness-audit']
    );
    assert.ok(
      !waiting.structuredContent?.opportunisticStages?.some((stage) => stage.id === 'write-followup')
    );
    assert.match(waiting.content?.[0]?.text ?? '', /waiting on external dependency.*ci/is);
    assert.match(waiting.content?.[0]?.text ?? '', /recommended.*readiness-audit/is);

    const audit = await client.callTool({
      name: 'project_workflow',
      arguments: {
        action: 'record',
        projectRoot: repo,
        stageId: 'readiness-audit',
        status: 'completed',
        evidence: {
          kind: 'agent_attestation',
          summary: 'Read-only readiness audit completed.'
        }
      }
    });
    assert.ok(!audit.isError);
    assert.strictEqual(audit.structuredContent?.recommendedStage?.id, 'ci');
    assert.match(audit.content?.[0]?.text ?? '', /re-check|waiting on external dependency/is);

    console.log('✅ Real MCP opportunistic workflow integration test passed');
  } finally {
    await client.close();
  }
} finally {
  await fs.rm(tempDir, { recursive: true, force: true });
}
