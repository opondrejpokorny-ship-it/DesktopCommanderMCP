/** Reproducible M0 scale benchmark for current Operational Memory JSONL retrieval. */
import assert from 'node:assert';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { performance } from 'node:perf_hooks';

import {
  getProjectWorkflowStatus,
  recordOperationalToolFailure,
  resolveWorkflowMemoryPath,
  startProjectWorkflow,
} from '../../dist/workflow/project-workflow.js';

const DATASETS = [10_000, 100_000, 1_000_000];
const CHUNK_SIZE = 10_000;
const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'dc-memory-scale-benchmark-'));
const projectRoot = path.join(tempDir, 'repo');
const stateRoot = path.join(tempDir, 'state');
const previousStateRoot = process.env.DESKTOP_COMMANDER_WORKFLOW_STATE_DIR;
process.env.DESKTOP_COMMANDER_WORKFLOW_STATE_DIR = stateRoot;

function git(...args) {
  return execFileSync('git', ['-C', projectRoot, ...args], { encoding: 'utf8' }).trim();
}
function compactClone(seed, dataset, index) {
  return {
    version: 1,
    id: `bench-${dataset}-${index}`,
    workflowId: seed.workflowId,
    sourceTool: seed.sourceTool,
    reasonCode: seed.reasonCode,
    fingerprint: seed.fingerprint,
    occurredAt: new Date(Date.UTC(2026, 8, 4, 12, 0, 0) + index).toISOString(),
  };
}

async function writeDataset(memoryPath, seed, eventCount) {
  const handle = await fs.open(memoryPath, 'w');
  const startedAt = performance.now();
  try {
    for (let start = 0; start < eventCount; start += CHUNK_SIZE) {
      const end = Math.min(eventCount, start + CHUNK_SIZE);
      const lines = [];
      for (let index = start; index < end; index += 1) {
        lines.push(JSON.stringify(compactClone(seed, eventCount, index)));
      }
      await handle.write(lines.join('\n') + '\n');
    }
  } finally {
    await handle.close();
  }
  return performance.now() - startedAt;
}
try {
  await fs.mkdir(path.join(projectRoot, '.desktop-commander'), { recursive: true });
  await fs.writeFile(
    path.join(projectRoot, '.desktop-commander', 'project-workflow.json'),
    JSON.stringify({
      version: 1,
      id: 'memory-scale-benchmark',
      name: 'Operational Memory scale benchmark',
      stages: [{ id: 'inspect', label: 'Inspect', required: true }],
    }, null, 2),
  );
  execFileSync('git', ['init', projectRoot]);
  git('config', 'user.email', 'test@example.invalid');
  git('config', 'user.name', 'Memory Benchmark');
  await fs.writeFile(path.join(projectRoot, 'README.md'), '# benchmark\n');
  git('add', '.');
  git('commit', '-m', 'baseline');

  const started = await startProjectWorkflow({ projectRoot, goal: 'Benchmark memory scale' });
  const recorded = await recordOperationalToolFailure({
    tool: 'read_file',
    args: { path: path.join(projectRoot, 'missing.txt') },
    result: { content: [{ type: 'text', text: 'Error: ENOENT missing resource' }], isError: true },
  });
  assert.strictEqual(recorded, true);
  const memoryPath = resolveWorkflowMemoryPath(projectRoot);
  const [seedLine] = (await fs.readFile(memoryPath, 'utf8')).trim().split(/\r?\n/);
  const seed = JSON.parse(seedLine);
  assert.strictEqual(seed.workflowId, started.workflowId);

  console.log(JSON.stringify({
    type: 'meta',
    node: process.version,
    platform: process.platform,
    arch: process.arch,
    datasets: DATASETS,
    chunkSize: CHUNK_SIZE,
  }));

  for (const eventCount of DATASETS) {
    const generationMs = await writeDataset(memoryPath, seed, eventCount);
    const fileBytes = (await fs.stat(memoryPath)).size;
    const rssBefore = process.memoryUsage().rss;
    const statusStartedAt = performance.now();
    const status = await getProjectWorkflowStatus({ projectRoot });
    const statusMs = performance.now() - statusStartedAt;
    const rssAfter = process.memoryUsage().rss;

    const appendStartedAt = performance.now();
    const appended = await recordOperationalToolFailure({
      tool: 'read_file',
      args: { path: path.join(projectRoot, 'missing-after-large-journal.txt') },
      result: { content: [{ type: 'text', text: 'Error: ENOENT missing resource' }], isError: true },
    });
    const appendMs = performance.now() - appendStartedAt;
    assert.strictEqual(appended, true);
    assert.ok(status.operationalMemory.totalEvents <= 1000);
    assert.ok(status.operationalMemory.lessons.length <= 8);

    console.log(JSON.stringify({
      type: 'dataset',
      eventCount,
      fileBytes,
      generationMs: Number(generationMs.toFixed(3)),
      statusMs: Number(statusMs.toFixed(3)),
      appendMs: Number(appendMs.toFixed(3)),
      rssBefore,
      rssAfter,
      rssDelta: rssAfter - rssBefore,
      totalEvents: status.operationalMemory.totalEvents,
      uniqueLessons: status.operationalMemory.uniqueLessons,
      returnedLessons: status.operationalMemory.lessons.length,
    }));
  }
} finally {
  if (previousStateRoot === undefined) {
    delete process.env.DESKTOP_COMMANDER_WORKFLOW_STATE_DIR;
  } else {
    process.env.DESKTOP_COMMANDER_WORKFLOW_STATE_DIR = previousStateRoot;
  }
  await fs.rm(tempDir, { recursive: true, force: true });
}
