/** RED: same-size/same-mtime JSONL rewrite must invalidate stale SQLite rows. */
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

const workflow = await import('../dist/workflow/project-workflow.js');
const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'dc-memory-m2-same-meta-'));
const projectRoot = path.join(tempDir, 'repo');
const stateRoot = path.join(tempDir, 'state');
const previousStateRoot = process.env.DESKTOP_COMMANDER_WORKFLOW_STATE_DIR;
process.env.DESKTOP_COMMANDER_WORKFLOW_STATE_DIR = stateRoot;

function git(...args) {
  return execFileSync('git', ['-C', projectRoot, ...args], { encoding: 'utf8' }).trim();
}

try {
  await fs.mkdir(path.join(projectRoot, '.desktop-commander'), { recursive: true });
  await fs.writeFile(path.join(projectRoot, '.desktop-commander', 'project-workflow.json'), JSON.stringify({
    version: 1,
    id: 'memory-m2-same-meta',
    name: 'Operational Memory M2 same metadata rewrite',
    stages: [{ id: 'inspect', label: 'Inspect', required: true }],
  }, null, 2));
  execFileSync('git', ['init', projectRoot]);
  git('config', 'user.email', 'same-meta@example.invalid');
  git('config', 'user.name', 'Memory Same Metadata Test');
  await fs.writeFile(path.join(projectRoot, 'README.md'), '# same metadata\n');
  git('add', '.');
  git('commit', '-m', 'baseline');

  await workflow.startProjectWorkflow({ projectRoot, goal: 'Never trust stale derived rows' });
  for (let i = 0; i < 2; i += 1) {
    assert.equal(await workflow.recordOperationalToolFailure({
      tool: 'read_file',
      args: { path: path.join(projectRoot, 'missing.txt') },
      result: { content: [{ type: 'text', text: 'Error: ENOENT missing resource' }], isError: true },
    }), true);
  }
  const memoryPath = workflow.resolveWorkflowMemoryPath(projectRoot);
  const stableMtimeSeconds = Math.floor(Date.now() / 1000) - 5;
  await fs.utimes(memoryPath, stableMtimeSeconds, stableMtimeSeconds);
  const beforeStatus = await workflow.getProjectWorkflowStatus({ projectRoot });
  const beforeStat = await fs.stat(memoryPath);
  assert.equal(beforeStat.mtimeMs, stableMtimeSeconds * 1000);
  const lines = (await fs.readFile(memoryPath, 'utf8')).trimEnd().split(/\r?\n/);
  const rewrittenLines = lines.map((line, index) => {
    const event = JSON.parse(line);
    event.occurredAt = new Date(Date.parse(event.occurredAt) + (index + 1) * 86_400_000).toISOString();
    return JSON.stringify(event);
  });
  const rewritten = rewrittenLines.join('\n') + '\n';
  assert.equal(Buffer.byteLength(rewritten), beforeStat.size, 'fixture must preserve authority byte size');
  await fs.writeFile(memoryPath, rewritten, 'utf8');
  await fs.utimes(memoryPath, stableMtimeSeconds, stableMtimeSeconds);
  const rewrittenStat = await fs.stat(memoryPath);
  assert.equal(rewrittenStat.size, beforeStat.size);
  assert.equal(rewrittenStat.mtimeMs, beforeStat.mtimeMs,
    'fixture must restore the exact mtime used by the SQLite fast path');
  assert.notEqual(rewrittenStat.ctimeMs, beforeStat.ctimeMs,
    'fixture must prove content overwrite changes filesystem ctime even when mtime is restored');

  const expectedLastSeenAt = JSON.parse(rewrittenLines[1]).occurredAt;
  assert.notEqual(expectedLastSeenAt, beforeStatus.operationalMemory.lessons[0].lastSeenAt);

  const afterStatus = await workflow.getProjectWorkflowStatus({ projectRoot });
  assert.equal(afterStatus.operationalMemory.totalEvents, 2);
  assert.equal(afterStatus.operationalMemory.lessons[0].lastSeenAt, expectedLastSeenAt,
    'same-size/same-mtime rewrite must be read from current JSONL authority, not stale SQLite');
  console.log('PASS M2 detects same-size/same-mtime JSONL authority rewrite');
} finally {
  if (previousStateRoot === undefined) delete process.env.DESKTOP_COMMANDER_WORKFLOW_STATE_DIR;
  else process.env.DESKTOP_COMMANDER_WORKFLOW_STATE_DIR = previousStateRoot;
  await fs.rm(tempDir, { recursive: true, force: true });
}
