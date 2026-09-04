/** Expected RED for future scoped/indexed Operational Memory retrieval. */
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
} from '../../dist/workflow/project-workflow.js';

const failures = [];

async function check(name, fn) {
  try {
    await fn();
    console.log('GREEN ' + name);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    failures.push(name + ': ' + message);
    console.error('RED ' + name + ': ' + message);
  }
}
async function withFixture(label, fn) {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), `dc-memory-red-${label}-`));
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
        id: `memory-red-${label}`,
        name: `Memory expected RED ${label}`,
        stages: [{ id: 'inspect', label: 'Inspect', required: true }],
      }, null, 2),
    );
    execFileSync('git', ['init', projectRoot]);
    execFileSync('git', ['-C', projectRoot, 'config', 'user.email', 'test@example.invalid']);
    execFileSync('git', ['-C', projectRoot, 'config', 'user.name', 'Memory RED Test']);
    await fs.writeFile(path.join(projectRoot, 'README.md'), '# expected red\n');
    execFileSync('git', ['-C', projectRoot, 'add', '.']);
    execFileSync('git', ['-C', projectRoot, 'commit', '-m', 'baseline']);
    await fn({ projectRoot });
  } finally {
    if (previousStateRoot === undefined) {
      delete process.env.DESKTOP_COMMANDER_WORKFLOW_STATE_DIR;
    } else {
      process.env.DESKTOP_COMMANDER_WORKFLOW_STATE_DIR = previousStateRoot;
    }
    await fs.rm(tempDir, { recursive: true, force: true });
  }
}

async function recordNotFound(projectRoot) {
  const recorded = await recordOperationalToolFailure({
    tool: 'read_file',
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
await check('same-project lesson survives workflow restart', async () => {
  await withFixture('project-history', async ({ projectRoot }) => {
    await startProjectWorkflow({ projectRoot, goal: 'First workflow' });
    const learned = await recordOperationalLesson({
      projectRoot,
      lessonCode: 'fetch_required_git_refs',
    });
    assert.strictEqual(learned, true);

    const second = await startProjectWorkflow({
      projectRoot,
      goal: 'Second workflow',
      restart: true,
    });
    assert.ok(
      second.operationalMemory.lessons.some(
        (lesson) => lesson.lessonCode === 'fetch_required_git_refs',
      ),
      'future project scope should preserve relevant lessons across workflow IDs',
    );
  });
});

await check('old valuable lesson survives beyond bounded journal tail', async () => {
  await withFixture('old-tail', async ({ projectRoot }) => {
    await startProjectWorkflow({ projectRoot, goal: 'Tail retention' });
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
      padded.push({
        ...failureSeed,
        id: `expected-red-${index}`,
        occurredAt: new Date(Date.UTC(2026, 8, 4, 11, 0, 0) + index).toISOString(),
        padding: 'x'.repeat(2048),
      });
    }
    await fs.appendFile(
      memoryPath,
      padded.map((event) => JSON.stringify(event)).join('\n') + '\n',
    );

    const status = await getProjectWorkflowStatus({ projectRoot });
    assert.ok(
      status.operationalMemory.lessons.some(
        (lesson) => lesson.lessonCode === 'fetch_required_git_refs',
      ),
      'future indexed retrieval should retain valuable lessons beyond the hot tail',
    );
  });
});
if (failures.length > 0) {
  throw new Error(
    'Expected future Operational Memory behavior remains RED:\n' + failures.join('\n'),
  );
}

console.log('✅ Future scoped/indexed Operational Memory retrieval is GREEN');
