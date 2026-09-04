/** M0 characterization for current Operational Memory scale semantics. */
import assert from 'node:assert';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import {
  getProjectWorkflowStatus,
  recordOperationalLesson,
  recordOperationalToolFailure,
  resolveWorkflowMemoryPath,
  startProjectWorkflow,
} from '../dist/workflow/project-workflow.js';

const TAIL_BYTES = 512 * 1024;

async function withFixture(label, fn) {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), `dc-memory-scale-${label}-`));
  const projectRoot = path.join(tempDir, 'repo');
  const stateRoot = path.join(tempDir, 'state');
  const previousStateRoot = process.env.DESKTOP_COMMANDER_WORKFLOW_STATE_DIR;
  process.env.DESKTOP_COMMANDER_WORKFLOW_STATE_DIR = stateRoot;

  try {
    await fs.mkdir(path.join(projectRoot, '.desktop-commander'), { recursive: true });
    await fs.writeFile(
      path.join(projectRoot, '.desktop-commander', 'project-workflow.json'),
      JSON.stringify({
        version: 1,
        id: `memory-scale-${label}`,
        name: `Operational Memory scale ${label}`,
        stages: [{ id: 'inspect', label: 'Inspect', required: true }],
      }, null, 2),
    );

    execFileSync('git', ['init', projectRoot]);
    execFileSync('git', ['-C', projectRoot, 'config', 'user.email', 'test@example.invalid']);
    execFileSync('git', ['-C', projectRoot, 'config', 'user.name', 'Memory Scale Test']);
    await fs.writeFile(path.join(projectRoot, 'README.md'), '# scale test\n');
    execFileSync('git', ['-C', projectRoot, 'add', '.']);
    execFileSync('git', ['-C', projectRoot, 'commit', '-m', 'baseline']);

    const started = await startProjectWorkflow({ projectRoot, goal: `Characterize ${label}` });
    await fn({ tempDir, projectRoot, stateRoot, workflowId: started.workflowId });
  } finally {
    if (previousStateRoot === undefined) {
      delete process.env.DESKTOP_COMMANDER_WORKFLOW_STATE_DIR;
    } else {
      process.env.DESKTOP_COMMANDER_WORKFLOW_STATE_DIR = previousStateRoot;
    }
    await fs.rm(tempDir, { recursive: true, force: true });
  }
}
async function recordNotFound(projectRoot, tool = 'read_file') {
  const recorded = await recordOperationalToolFailure({
    tool,
    args: { path: path.join(projectRoot, 'missing.txt') },
    result: { content: [{ type: 'text', text: 'Error: ENOENT missing resource' }], isError: true },
  });
  assert.strictEqual(recorded, true);
}

async function readEvents(memoryPath) {
  return (await fs.readFile(memoryPath, 'utf8'))
    .trim()
    .split(/\r?\n/)
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}

function cloneEvent(seed, index, overrides = {}) {
  return {
    ...seed,
    id: `scale-event-${index}`,
    occurredAt: new Date(Date.UTC(2026, 8, 4, 10, 0, 0) + index).toISOString(),
    ...overrides,
  };
}

async function appendEvents(memoryPath, events) {
  await fs.appendFile(memoryPath, events.map((event) => JSON.stringify(event)).join('\n') + '\n');
}
await withFixture('event-cap', async ({ projectRoot }) => {
  await recordNotFound(projectRoot);
  const memoryPath = resolveWorkflowMemoryPath(projectRoot);
  const [seed] = await readEvents(memoryPath);
  const clones = [];
  for (let index = 1; index < 1100; index += 1) {
    clones.push(cloneEvent(seed, index));
  }
  await appendEvents(memoryPath, clones);

  const status = await getProjectWorkflowStatus({ projectRoot });
  assert.strictEqual(status.operationalMemory.totalEvents, 1000);
  assert.strictEqual(status.operationalMemory.lessons.length, 1);
  assert.strictEqual(status.operationalMemory.lessons[0].occurrences, 1000);
  console.log('PASS current retrieval caps parsed events at 1000');
});

await withFixture('workflow-filter', async ({ projectRoot }) => {
  await recordNotFound(projectRoot);
  await recordNotFound(projectRoot);
  const memoryPath = resolveWorkflowMemoryPath(projectRoot);
  const [seed] = await readEvents(memoryPath);
  await appendEvents(memoryPath, [
    cloneEvent(seed, 3, { workflowId: 'different-workflow' }),
  ]);

  const status = await getProjectWorkflowStatus({ projectRoot });
  assert.strictEqual(status.operationalMemory.totalEvents, 2);
  assert.strictEqual(status.operationalMemory.lessons[0].occurrences, 2);
  console.log('PASS current retrieval filters to the active workflowId');
});
await withFixture('tail-cap', async ({ projectRoot }) => {
  const learned = await recordOperationalLesson({
    projectRoot,
    lessonCode: 'fetch_required_git_refs',
  });
  assert.strictEqual(learned, true);
  await recordNotFound(projectRoot);

  const memoryPath = resolveWorkflowMemoryPath(projectRoot);
  const events = await readEvents(memoryPath);
  const failureSeed = events.find((event) => event.reasonCode === 'not_found');
  assert.ok(failureSeed);
  const padded = [];
  for (let index = 0; index < 300; index += 1) {
    padded.push(cloneEvent(failureSeed, 1000 + index, { padding: 'x'.repeat(2048) }));
  }
  await appendEvents(memoryPath, padded);

  const stat = await fs.stat(memoryPath);
  assert.ok(stat.size > TAIL_BYTES, `journal must exceed ${TAIL_BYTES} bytes`);
  const status = await getProjectWorkflowStatus({ projectRoot });
  assert.ok(status.operationalMemory.totalEvents > 0);
  assert.ok(status.operationalMemory.totalEvents < 302);
  assert.ok(
    !status.operationalMemory.lessons.some((lesson) => lesson.lessonCode === 'fetch_required_git_refs'),
    'current bounded-tail retrieval should omit the old semantic lesson',
  );
  console.log('PASS current retrieval reads only the recent 512 KiB journal tail');
});
await withFixture('lesson-cap', async ({ projectRoot }) => {
  const tools = [
    'read_file',
    'read_multiple_files',
    'list_directory',
    'get_file_info',
    'write_file',
    'edit_block',
    'start_process',
    'read_process_output',
    'interact_with_process',
  ];

  for (const tool of tools) {
    await recordNotFound(projectRoot, tool);
  }

  const status = await getProjectWorkflowStatus({ projectRoot });
  assert.strictEqual(status.operationalMemory.uniqueLessons, 9);
  assert.strictEqual(status.operationalMemory.lessons.length, 8);
  console.log('PASS current model-facing memory returns at most 8 lessons');
});

console.log('✅ Operational Memory scale characterization passed');
