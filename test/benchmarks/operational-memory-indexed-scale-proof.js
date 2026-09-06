/** Reproducible M8 proof: indexed retrieval, rebuild recovery, incremental sync, and privacy. */
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import { DatabaseSync } from 'node:sqlite';

import {
  getProjectWorkflowStatus,
  recordOperationalToolFailure,
  resolveWorkflowMemoryPath,
  startProjectWorkflow,
} from '../../dist/workflow/project-workflow.js';
import { resolveWorkflowMemoryIndexPath } from '../../dist/workflow/workflow-storage.js';

const DEFAULT_DATASETS = [10_000, 100_000, 1_000_000];
const CHUNK_SIZE = 10_000;
const FORBIDDEN_MARKERS = [
  'FAKE_API_KEY_SECRET_M8',
  'PRIVATE_RAW_COMMAND_M8',
  'PRIVATE_FILE_CONTENT_M8',
  'PRIVATE_MCP_ARGS_M8',
  'PRIVATE_APPROVAL_PAYLOAD_M8',
];

function parseDatasets(argv) {
  const raw = argv.find((arg) => arg.startsWith('--datasets='))?.slice('--datasets='.length);
  if (!raw) return DEFAULT_DATASETS;
  const values = raw.split(',').map((value) => Number(value));
  assert.ok(values.length > 0 && values.every((value) => Number.isInteger(value) && value > 0));
  return values;
}
function compactClone(seed, dataset, index) {
  return {
    version: 1,
    id: `m8-${dataset}-${index}`,
    workflowId: seed.workflowId,
    sourceTool: seed.sourceTool,
    reasonCode: seed.reasonCode,
    fingerprint: seed.fingerprint,
    occurredAt: new Date(Date.UTC(2026, 8, 5, 12, 0, 0) + index).toISOString(),
  };
}

async function writeDataset(memoryPath, seed, eventCount) {
  const handle = await fs.open(memoryPath, 'w');
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
}

async function sha256(filePath) {
  return crypto.createHash('sha256').update(await fs.readFile(filePath)).digest('hex');
}
function readIndexCounts(indexPath) {
  const db = new DatabaseSync(indexPath, { readOnly: true });
  try {
    const indexedEventCount = Number(db.prepare('SELECT COUNT(*) AS count FROM events').get().count);
    const recordCount = Number(db.prepare('SELECT record_count FROM index_state WHERE id = 1').get().record_count);
    return { indexedEventCount, recordCount };
  } finally {
    db.close();
  }
}

function semanticStatus(status) {
  return {
    totalEvents: status.operationalMemory.totalEvents,
    uniqueLessons: status.operationalMemory.uniqueLessons,
    lessons: status.operationalMemory.lessons.map((lesson) => ({
      fingerprint: lesson.fingerprint,
      occurrences: lesson.occurrences,
      reasonCode: lesson.reasonCode,
      lessonCode: lesson.lessonCode,
      scope: lesson.scope,
      relevanceReason: lesson.relevanceReason,
    })),
  };
}

function git(projectRoot, ...args) {
  return execFileSync('git', ['-C', projectRoot, ...args], { encoding: 'utf8' }).trim();
}
async function recordMarkedFailure(projectRoot) {
  return recordOperationalToolFailure({
    tool: 'read_file',
    args: {
      path: path.join(projectRoot, 'missing-FAKE_API_KEY_SECRET_M8.txt'),
      rawCommand: 'PRIVATE_RAW_COMMAND_M8',
      mcpArgs: 'PRIVATE_MCP_ARGS_M8',
      approvalPayload: 'PRIVATE_APPROVAL_PAYLOAD_M8',
    },
    result: {
      content: [{
        type: 'text',
        text: 'Error: ENOENT PRIVATE_FILE_CONTENT_M8 FAKE_API_KEY_SECRET_M8 PRIVATE_RAW_COMMAND_M8',
      }],
      isError: true,
    },
  });
}

async function assertNoForbiddenMarkers(...filePaths) {
  for (const filePath of filePaths) {
    const bytes = await fs.readFile(filePath);
    const text = bytes.toString('latin1');
    for (const marker of FORBIDDEN_MARKERS) {
      assert.equal(text.includes(marker), false, `${path.basename(filePath)} leaked ${marker}`);
    }
  }
  return true;
}
async function runDataset(eventCount) {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), `dc-memory-m8-${eventCount}-`));
  const projectRoot = path.join(tempDir, 'repo');
  const stateRoot = path.join(tempDir, 'state');
  const previousStateRoot = process.env.DESKTOP_COMMANDER_WORKFLOW_STATE_DIR;
  process.env.DESKTOP_COMMANDER_WORKFLOW_STATE_DIR = stateRoot;
  try {
    await fs.mkdir(path.join(projectRoot, '.desktop-commander'), { recursive: true });
    await fs.writeFile(path.join(projectRoot, '.desktop-commander', 'project-workflow.json'), JSON.stringify({
      version: 1,
      id: `memory-m8-proof-${eventCount}`,
      name: `Operational Memory M8 proof ${eventCount}`,
      stages: [{ id: 'inspect', label: 'Inspect', required: true }],
    }, null, 2));
    execFileSync('git', ['init', projectRoot], { stdio: 'ignore' });
    git(projectRoot, 'config', 'user.email', 'm8-proof@example.invalid');
    git(projectRoot, 'config', 'user.name', 'Memory M8 Proof');
    await fs.writeFile(path.join(projectRoot, 'README.md'), '# M8 proof\n');
    git(projectRoot, 'add', '.');
    git(projectRoot, 'commit', '-m', 'baseline');

    await startProjectWorkflow({ projectRoot, goal: `Prove indexed memory at ${eventCount} events` });
    assert.equal(await recordMarkedFailure(projectRoot), true);
    const memoryPath = resolveWorkflowMemoryPath(projectRoot);
    const indexPath = resolveWorkflowMemoryIndexPath(projectRoot);
    const [seedLine] = (await fs.readFile(memoryPath, 'utf8')).trim().split(/\r?\n/);
    const seed = JSON.parse(seedLine);
    await assertNoForbiddenMarkers(memoryPath);
    await writeDataset(memoryPath, seed, eventCount);
    await fs.rm(indexPath, { force: true });

    const initialRebuildStarted = performance.now();
    const initialStatus = await getProjectWorkflowStatus({ projectRoot });
    const initialRebuildMs = performance.now() - initialRebuildStarted;
    const initialCounts = readIndexCounts(indexPath);
    assert.equal(initialCounts.indexedEventCount, eventCount);
    assert.equal(initialCounts.recordCount, eventCount);

    const indexHashBeforeSteady = await sha256(indexPath);
    const steadyStarted = performance.now();
    const steadyStatus = await getProjectWorkflowStatus({ projectRoot });
    const steadyStateMs = performance.now() - steadyStarted;
    const indexHashAfterSteady = await sha256(indexPath);
    assert.deepEqual(semanticStatus(steadyStatus), semanticStatus(initialStatus));
    const steadyStateIndexUnchanged = indexHashBeforeSteady === indexHashAfterSteady;
    assert.equal(steadyStateIndexUnchanged, true);

    const incrementalStarted = performance.now();
    assert.equal(await recordMarkedFailure(projectRoot), true);
    const incrementalAppendMs = performance.now() - incrementalStarted;
    const incrementalCounts = readIndexCounts(indexPath);
    assert.equal(incrementalCounts.indexedEventCount, eventCount + 1);
    assert.equal(incrementalCounts.recordCount, eventCount + 1);
    const statusAfterIncremental = await getProjectWorkflowStatus({ projectRoot });
    const semanticAfterIncremental = semanticStatus(statusAfterIncremental);
    await assertNoForbiddenMarkers(memoryPath, indexPath);

    await fs.rm(indexPath, { force: true });
    const rebuildAfterDeleteStarted = performance.now();
    const rebuiltStatus = await getProjectWorkflowStatus({ projectRoot });
    const rebuildAfterDeleteMs = performance.now() - rebuildAfterDeleteStarted;
    const rebuiltCounts = readIndexCounts(indexPath);
    assert.equal(rebuiltCounts.indexedEventCount, eventCount + 1);
    assert.equal(rebuiltCounts.recordCount, eventCount + 1);
    const rebuildEquivalent = JSON.stringify(semanticStatus(rebuiltStatus)) === JSON.stringify(semanticAfterIncremental);
    assert.equal(rebuildEquivalent, true);
    const privacyMarkersAbsent = await assertNoForbiddenMarkers(memoryPath, indexPath);

    const [journalStat, indexStat] = await Promise.all([fs.stat(memoryPath), fs.stat(indexPath)]);
    return {
      type: 'dataset',
      eventCount,
      journalBytes: journalStat.size,
      indexBytes: indexStat.size,
      indexedEventCount: rebuiltCounts.indexedEventCount,
      initialRebuildMs: Number(initialRebuildMs.toFixed(3)),
      steadyStateMs: Number(steadyStateMs.toFixed(3)),
      incrementalAppendMs: Number(incrementalAppendMs.toFixed(3)),
      rebuildAfterDeleteMs: Number(rebuildAfterDeleteMs.toFixed(3)),
      incrementalCountVerified: rebuiltCounts.indexedEventCount === eventCount + 1,
      steadyStateIndexUnchanged,
      rebuildEquivalent,
      privacyMarkersAbsent,
      modelFacingEvents: rebuiltStatus.operationalMemory.totalEvents,
      returnedLessons: rebuiltStatus.operationalMemory.lessons.length,
    };
  } finally {
    if (previousStateRoot === undefined) delete process.env.DESKTOP_COMMANDER_WORKFLOW_STATE_DIR;
    else process.env.DESKTOP_COMMANDER_WORKFLOW_STATE_DIR = previousStateRoot;
    await fs.rm(tempDir, { recursive: true, force: true });
  }
}

const datasets = parseDatasets(process.argv.slice(2));
console.log(JSON.stringify({
  type: 'meta',
  proofVersion: 1,
  node: process.version,
  platform: process.platform,
  arch: process.arch,
  datasets,
  chunkSize: CHUNK_SIZE,
}));
for (const eventCount of datasets) {
  console.log(JSON.stringify(await runDataset(eventCount)));
}
