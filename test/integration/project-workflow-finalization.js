/**
 * Real MCP restart/resume coverage for required workflow finalization.
 */
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
const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'dc-workflow-finalization-mcp-'));
const repo = path.join(tempDir, 'repo');
const stateRoot = path.join(tempDir, 'state');
const policyFile = path.join(tempDir, 'policy.json');
const approvalFile = path.join(tempDir, 'approvals.json');

function git(...args) {
  return execFileSync('git', ['-C', repo, ...args], { encoding: 'utf8' }).trim();
}

const proof = (summary) => ({
  kind: 'provider_reference', summary, reference: 'ci://finalization-proof'
});

async function connectClient(name) {
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
  const client = new Client({ name, version: '1.0.0' }, { capabilities: {} });
  await client.connect(transport, { timeout: 30000 });
  return client;
}

try {
  await fs.mkdir(path.join(repo, '.desktop-commander'), { recursive: true });
  await fs.writeFile(path.join(repo, '.desktop-commander', 'project-workflow.json'), JSON.stringify({
    version: 1,
    id: 'finalization-restart-test',
    name: 'Finalization restart test',
    stages: [
      { id: 'integration', label: 'Integration', required: true },
      { id: 'verify-sha', label: 'Verify SHA', required: true, dependsOn: ['integration'], evidenceScope: 'git_head' },
      { id: 'post-merge-ci', label: 'Post-merge CI', required: true, dependsOn: ['verify-sha'], evidenceScope: 'git_head', workMode: 'read_only' },
      { id: 'docs-sync', label: 'Docs sync', required: true, dependsOn: ['post-merge-ci'] },
      { id: 'registry-cleanup', label: 'Registry cleanup', required: true, dependsOn: ['docs-sync'] },
      { id: 'final-report', label: 'Final report', required: true, dependsOn: ['registry-cleanup'] },
    ],
  }, null, 2));
  await fs.writeFile(policyFile, JSON.stringify({ version: 1, tier: 'free', rules: [] }));

  execFileSync('git', ['init', repo]);
  git('config', 'user.email', 'test@example.invalid');
  git('config', 'user.name', 'Finalization MCP Test');
  await fs.writeFile(path.join(repo, 'README.md'), '# finalization integration\n');
  git('add', '.');
  git('commit', '-m', 'baseline');

  const first = await connectClient('finalization-first-client');
  try {
    assert.match(first.getInstructions() ?? '', /waiting_external/);
    assert.match(first.getInstructions() ?? '', /unfinished finalization|finalization/i);
    let result = await first.callTool({ name: 'project_workflow', arguments: {
      action: 'start', projectRoot: repo, goal: 'Persist finalization across a client restart'
    }});
    assert.ok(!result.isError, JSON.stringify(result));
    for (const [stageId, summary] of [
      ['integration', 'Integrated.'],
      ['verify-sha', 'Exact merged SHA verified.'],
    ]) {
      result = await first.callTool({ name: 'project_workflow', arguments: {
        action: 'record', projectRoot: repo, stageId, status: 'completed', evidence: proof(summary)
      }});
      assert.ok(!result.isError, JSON.stringify(result));
    }
    result = await first.callTool({ name: 'project_workflow', arguments: {
      action: 'record', projectRoot: repo, stageId: 'post-merge-ci',
      status: 'waiting_external', reason: 'Merged-SHA CI is still running.'
    }});
    assert.ok(!result.isError, JSON.stringify(result));
    assert.strictEqual(result.structuredContent?.recommendedStage?.id, 'post-merge-ci');
  } finally {
    await first.close();
  }

  const resumedClient = await connectClient('finalization-resumed-client');
  try {
    let result = await resumedClient.callTool({ name: 'project_workflow', arguments: {
      action: 'resume', projectRoot: repo
    }});
    assert.ok(!result.isError, JSON.stringify(result));
    assert.strictEqual(result.structuredContent?.recommendedStage?.id, 'post-merge-ci');
    assert.deepStrictEqual(
      result.structuredContent?.waitingStages?.map((stage) => stage.id), ['post-merge-ci']
    );
    assert.match(result.content?.[0]?.text ?? '', /re-check|waiting on external dependency/is);

    result = await resumedClient.callTool({ name: 'project_workflow', arguments: {
      action: 'record', projectRoot: repo, stageId: 'docs-sync',
      status: 'completed', evidence: proof('Too early.')
    }});
    assert.strictEqual(result.isError, true);
    assert.match(result.content?.[0]?.text ?? '', /depend|post-merge-ci|prerequisite/i);

    result = await resumedClient.callTool({ name: 'project_workflow', arguments: {
      action: 'finish', projectRoot: repo
    }});
    assert.strictEqual(result.isError, true);
    assert.match(result.content?.[0]?.text ?? '', /post-merge-ci|incomplete|waiting/i);

    for (const [stageId, summary] of [
      ['post-merge-ci', 'Merged-SHA CI passed.'],
      ['docs-sync', 'Durable docs updated.'],
      ['registry-cleanup', 'Registry entry removed.'],
      ['final-report', 'Final report delivered.'],
    ]) {
      result = await resumedClient.callTool({ name: 'project_workflow', arguments: {
        action: 'record', projectRoot: repo, stageId, status: 'completed', evidence: proof(summary)
      }});
      assert.ok(!result.isError, JSON.stringify(result));
    }

    result = await resumedClient.callTool({ name: 'project_workflow', arguments: {
      action: 'finish', projectRoot: repo
    }});
    assert.ok(!result.isError, JSON.stringify(result));
    assert.strictEqual(result.structuredContent?.completed, true);
    assert.strictEqual(result.structuredContent?.progress?.percentRemaining, 0);
    console.log('✅ Real MCP workflow finalization restart/resume test passed');
  } finally {
    await resumedClient.close();
  }
} finally {
  await fs.rm(tempDir, { recursive: true, force: true });
}
