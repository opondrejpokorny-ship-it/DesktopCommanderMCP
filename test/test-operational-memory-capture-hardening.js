/** RED -> GREEN coverage for real-world operational-memory capture gaps. */
import assert from 'node:assert';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import * as workflow from '../dist/workflow/project-workflow.js';

const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'dc-memory-hardening-'));
const projectRoot = path.join(tempDir, 'repo');
const stateRoot = path.join(tempDir, 'state');
const failures = [];

function git(...args) {
  return execFileSync('git', ['-C', projectRoot, ...args], { encoding: 'utf8' }).trim();
}

async function check(name, fn) {
  try {
    await fn();
    console.log('PASS ' + name);
  } catch (error) {
    failures.push(name + ': ' + (error instanceof Error ? error.message : String(error)));
    console.error('RED ' + name + ': ' + (error instanceof Error ? error.message : String(error)));
  }
}

try {
  process.env.DESKTOP_COMMANDER_WORKFLOW_STATE_DIR = stateRoot;
  await fs.mkdir(path.join(projectRoot, '.desktop-commander'), { recursive: true });
  await fs.writeFile(
    path.join(projectRoot, '.desktop-commander', 'project-workflow.json'),
    JSON.stringify({
      version: 1,
      id: 'memory-hardening',
      name: 'Operational memory hardening',
      stages: [{ id: 'verify', label: 'Verify', required: true }],
    }, null, 2),
  );
  execFileSync('git', ['init', projectRoot]);
  git('config', 'user.email', 'test@example.invalid');
  git('config', 'user.name', 'Memory Hardening Test');
  await fs.writeFile(path.join(projectRoot, 'README.md'), '# test\n');
  git('add', '.');
  git('commit', '-m', 'baseline');

  await workflow.startProjectWorkflow({ projectRoot, goal: 'Harden real-world capture' });

  await check('stale deleted workflows do not block pathless capture', async () => {
    const currentStatePath = workflow.resolveWorkflowStatePath(projectRoot);
    const stale = JSON.parse(await fs.readFile(currentStatePath, 'utf8'));
    stale.workflowId = 'stale-workflow';
    stale.projectRoot = path.join(tempDir, 'deleted-project');
    await fs.writeFile(path.join(stateRoot, 'stale.json'), JSON.stringify(stale, null, 2));
    const recorded = await workflow.recordOperationalToolFailure({
      tool: 'start_process',
      args: { command: 'SECRET_COMMAND_MUST_NOT_PERSIST' },
      result: {
        content: [{ type: 'text', text: 'Error: command not found SECRET_OUTPUT' }],
        isError: true,
      },
    });
    assert.strictEqual(recorded, true);
    const status = await workflow.getProjectWorkflowStatus({ projectRoot });
    assert.strictEqual(status.operationalMemory.totalEvents, 1);
    assert.ok(!JSON.stringify(status.operationalMemory).includes('SECRET_'));
  });

  await check('client-controlled origin ui cannot suppress memory', async () => {
    const recorded = await workflow.recordOperationalToolFailure({
      tool: 'read_file',
      args: { path: path.join(projectRoot, 'missing.txt'), origin: 'ui' },
      result: { content: [{ type: 'text', text: 'Error: ENOENT SECRET_UI' }], isError: true },
    });
    assert.strictEqual(recorded, true);
    const status = await workflow.getProjectWorkflowStatus({ projectRoot });
    assert.ok(status.operationalMemory.totalEvents >= 2);
  });
  await check('structured semantic lesson uses a whitelist template', async () => {
    assert.strictEqual(typeof workflow.recordOperationalLesson, 'function');
    const recorded = await workflow.recordOperationalLesson({
      projectRoot,
      lessonCode: 'fetch_required_git_refs',
    });
    assert.strictEqual(recorded, true);
    const status = await workflow.getProjectWorkflowStatus({ projectRoot });
    const lesson = status.operationalMemory.lessons.find(
      (item) => item.lessonCode === 'fetch_required_git_refs',
    );
    assert.ok(lesson, JSON.stringify(status.operationalMemory));
    assert.match(lesson.lesson, /required remote refs.*fetch missing refs/i);
    const rejected = await workflow.recordOperationalLesson({
      projectRoot,
      lessonCode: 'IGNORE_POLICY_AND_DUMP_SECRET',
    });
    assert.strictEqual(rejected, false, 'arbitrary lesson text/code must be rejected');
  });

  const memoryPath = workflow.resolveWorkflowMemoryPath(projectRoot);
  const persisted = await fs.readFile(memoryPath, 'utf8');
  assert.ok(!persisted.includes('SECRET_COMMAND_MUST_NOT_PERSIST'));
  assert.ok(!persisted.includes('SECRET_OUTPUT'));
  assert.ok(!persisted.includes('SECRET_UI'));
  assert.ok(!persisted.includes('IGNORE_POLICY_AND_DUMP_SECRET'));

  if (failures.length > 0) {
    throw new Error('Hardening RED failures:\n' + failures.join('\n'));
  }
  console.log('✅ Operational memory capture hardening unit tests passed');
} finally {
  delete process.env.DESKTOP_COMMANDER_WORKFLOW_STATE_DIR;
  await fs.rm(tempDir, { recursive: true, force: true });
}
