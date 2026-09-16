import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { execFileSync, spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'dc-memory-rotation-'));
const projectRoot = path.join(tempDir, 'repo');
const stateRoot = path.join(tempDir, 'state');
const profileDir = path.join(projectRoot, '.desktop-commander');
const previousStateRoot = process.env.DESKTOP_COMMANDER_WORKFLOW_STATE_DIR;
const previousNodeEnv = process.env.NODE_ENV;
const previousRotationBytes = process.env.DESKTOP_COMMANDER_TEST_OPERATIONAL_MEMORY_ROTATION_BYTES;

process.env.DESKTOP_COMMANDER_WORKFLOW_STATE_DIR = stateRoot;
process.env.NODE_ENV = 'test';
process.env.DESKTOP_COMMANDER_TEST_OPERATIONAL_MEMORY_ROTATION_BYTES = '1400';

const workflow = await import('../dist/workflow/project-workflow.js');
const storage = await import('../dist/workflow/workflow-storage.js');
const segments = await import('../dist/workflow/operational-memory-segments.js');

function git(...args) {
  return execFileSync('git', ['-C', projectRoot, ...args], { encoding: 'utf8' }).trim();
}

async function sha256(filePath) {
  return crypto.createHash('sha256').update(await fs.readFile(filePath)).digest('hex');
}

function memorySummary(status) {
  return {
    totalEvents: status.operationalMemory.totalEvents,
    uniqueLessons: status.operationalMemory.uniqueLessons,
    lessons: status.operationalMemory.lessons.map((lesson) => ({
      fingerprint: lesson.fingerprint,
      occurrences: lesson.occurrences,
      lessonCode: lesson.lessonCode,
      scope: lesson.scope,
      relevanceReason: lesson.relevanceReason,
    })),
  };
}

function archiveNames(names, memoryPath) {
  const stem = path.basename(memoryPath, '.jsonl').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const matcher = new RegExp('^' + stem + '\\.[0-9]{6}\\.jsonl$');
  return names.filter((name) => matcher.test(name)).sort();
}

async function assertValidJsonl(filePath) {
  const lines = (await fs.readFile(filePath, 'utf8')).split(/\r?\n/).filter(Boolean);
  assert.ok(lines.length > 0, path.basename(filePath) + ' must contain records');
  for (const line of lines) {
    assert.doesNotThrow(() => JSON.parse(line), path.basename(filePath) + ' contains invalid JSONL');
  }
}

async function countAuthorityEvents(memoryPath) {
  const journalSegments = await segments.listOperationalMemoryJournalSegments(memoryPath);
  let count = 0;
  for (const segment of journalSegments) {
    const lines = (await fs.readFile(segment.path, 'utf8')).split(/\r?\n/).filter(Boolean);
    for (const line of lines) {
      assert.doesNotThrow(() => JSON.parse(line), segment.name + ' contains invalid JSONL');
    }
    count += lines.length;
  }
  return { count, segments: journalSegments };
}

function runWriter(count, lessonCode) {
  const script = path.join(
    path.dirname(fileURLToPath(import.meta.url)),
    'fixtures',
    'operational-memory-writer.js',
  );
  return new Promise((resolve, reject) => {
    const child = spawn(
      process.execPath,
      [script, projectRoot, stateRoot, String(count), lessonCode],
      {
        cwd: process.cwd(),
        env: {
          ...process.env,
          NODE_ENV: 'test',
          DESKTOP_COMMANDER_TEST_OPERATIONAL_MEMORY_ROTATION_BYTES: '1400',
        },
        stdio: ['ignore', 'pipe', 'pipe'],
      },
    );
    let stderr = '';
    child.stderr.on('data', (chunk) => { stderr += chunk.toString(); });
    child.on('error', reject);
    child.on('exit', (code) => {
      if (code === 0) resolve();
      else reject(new Error('rotation writer exited ' + code + ': ' + stderr));
    });
  });
}

try {
  process.env.NODE_ENV = 'production';
  process.env.DESKTOP_COMMANDER_TEST_OPERATIONAL_MEMORY_ROTATION_BYTES = '1024';
  assert.equal(
    segments.operationalMemoryRotationBytes(),
    segments.OPERATIONAL_MEMORY_DEFAULT_ROTATION_BYTES,
    'production runtime must ignore the test-only rotation threshold override',
  );
  process.env.NODE_ENV = 'test';
  process.env.DESKTOP_COMMANDER_TEST_OPERATIONAL_MEMORY_ROTATION_BYTES = '1400';

  await fs.mkdir(profileDir, { recursive: true });
  await fs.writeFile(path.join(profileDir, 'project-workflow.json'), JSON.stringify({
    version: 1,
    id: 'memory-rotation-test',
    name: 'Operational Memory rotation test',
    stages: [{ id: 'verify', label: 'Verify', required: true }],
  }, null, 2));
  execFileSync('git', ['init', projectRoot], { stdio: 'ignore' });
  git('config', 'user.email', 'rotation@example.invalid');
  git('config', 'user.name', 'Memory Rotation Test');
  await fs.writeFile(path.join(projectRoot, 'README.md'), '# rotation\n');
  git('add', '.');
  git('commit', '-m', 'baseline');

  await workflow.startProjectWorkflow({ projectRoot, goal: 'Prove bounded immutable journal segments' });
  const lessonCodes = [
    'fetch_required_git_refs',
    'shell_quoting_unreliable',
    'tooling_availability_check',
  ];
  for (let index = 0; index < 30; index += 1) {
    assert.equal(await workflow.recordOperationalLesson({
      projectRoot,
      lessonCode: lessonCodes[index % lessonCodes.length],
    }), true);
  }

  const memoryPath = workflow.resolveWorkflowMemoryPath(projectRoot);
  const initialNames = await fs.readdir(stateRoot);
  const initialArchives = archiveNames(initialNames, memoryPath);
  assert.ok(initialArchives.length >= 2,
    'small test threshold must rotate the active journal into multiple immutable segments');
  for (const name of initialArchives) {
    await assertValidJsonl(path.join(stateRoot, name));
  }
  await assertValidJsonl(memoryPath);

  const firstArchivePath = path.join(stateRoot, initialArchives[0]);
  const firstArchiveHash = await sha256(firstArchivePath);
  const beforeRebuild = memorySummary(await workflow.getProjectWorkflowStatus({ projectRoot }));

  for (let index = 0; index < 12; index += 1) {
    assert.equal(await workflow.recordOperationalLesson({
      projectRoot,
      lessonCode: lessonCodes[(index + 1) % lessonCodes.length],
    }), true);
  }

  assert.equal(await sha256(firstArchivePath), firstArchiveHash,
    'closed archive segments must never be rewritten by later appends');
  const afterNames = await fs.readdir(stateRoot);
  const afterArchives = archiveNames(afterNames, memoryPath);
  assert.ok(afterArchives.length >= initialArchives.length,
    'default unlimited archival retention must not delete closed segments');

  const beforeConcurrent = await countAuthorityEvents(memoryPath);
  await Promise.all([
    runWriter(20, 'fetch_required_git_refs'),
    runWriter(20, 'shell_quoting_unreliable'),
  ]);
  const afterConcurrent = await countAuthorityEvents(memoryPath);
  assert.equal(
    afterConcurrent.count,
    beforeConcurrent.count + 40,
    'two cross-process writers must not lose events while rotating the shared journal',
  );
  const archiveSequences = afterConcurrent.segments
    .filter((segment) => !segment.active)
    .map((segment) => segment.sequence);
  assert.equal(
    new Set(archiveSequences).size,
    archiveSequences.length,
    'concurrent rotation must never reuse an archive sequence',
  );
  console.log('PASS concurrent writers rotate without collision or lost events');

  const indexPath = storage.resolveWorkflowMemoryIndexPath(projectRoot);
  while ((await fs.stat(memoryPath)).size < 1400) {
    assert.equal(await workflow.recordOperationalLesson({
      projectRoot,
      lessonCode: 'tooling_availability_check',
    }), true);
  }
  const beforeCrashBoundary = memorySummary(
    await workflow.getProjectWorkflowStatus({ projectRoot }),
  );
  assert.equal(
    await segments.rotateOperationalMemoryJournalIfNeeded(memoryPath),
    true,
    'test must close the hot journal to simulate a crash immediately after rename',
  );
  assert.equal(
    await fs.stat(memoryPath).then(() => true, () => false),
    false,
    'crash-boundary fixture must have archive authority with no active journal',
  );
  await fs.rm(indexPath, { force: true });
  const archiveOnlyRebuild = memorySummary(
    await workflow.getProjectWorkflowStatus({ projectRoot }),
  );
  assert.deepEqual(
    archiveOnlyRebuild,
    beforeCrashBoundary,
    'archive-only crash boundary must rebuild without an active journal',
  );
  assert.equal(await workflow.recordOperationalLesson({
    projectRoot,
    lessonCode: 'fetch_required_git_refs',
  }), true);
  assert.equal(
    await fs.stat(memoryPath).then((stat) => stat.isFile(), () => false),
    true,
    'the next normal append must recreate the active journal after archive-only recovery',
  );
  console.log('PASS rename-to-archive crash boundary recovers and recreates active journal');

  const expected = memorySummary(await workflow.getProjectWorkflowStatus({ projectRoot }));
  await fs.rm(indexPath, { force: true });
  const rebuilt = memorySummary(await workflow.getProjectWorkflowStatus({ projectRoot }));
  assert.deepEqual(rebuilt, expected,
    'deleting the derived SQLite index must rebuild equivalent memory from all journal segments');
  assert.ok(rebuilt.totalEvents >= beforeRebuild.totalEvents,
    'rotation must not lose current-workflow event history');
  assert.ok(rebuilt.lessons.length <= 8, 'model-facing lesson cap must remain bounded');

  const finalAuthority = await segments.listOperationalMemoryJournalSegments(memoryPath);
  for (const segment of finalAuthority) {
    await assertValidJsonl(segment.path);
  }
  console.log('PASS Operational Memory rotation/archive recovery contract');
} finally {
  if (previousStateRoot === undefined) delete process.env.DESKTOP_COMMANDER_WORKFLOW_STATE_DIR;
  else process.env.DESKTOP_COMMANDER_WORKFLOW_STATE_DIR = previousStateRoot;
  if (previousNodeEnv === undefined) delete process.env.NODE_ENV;
  else process.env.NODE_ENV = previousNodeEnv;
  if (previousRotationBytes === undefined) {
    delete process.env.DESKTOP_COMMANDER_TEST_OPERATIONAL_MEMORY_ROTATION_BYTES;
  } else {
    process.env.DESKTOP_COMMANDER_TEST_OPERATIONAL_MEMORY_ROTATION_BYTES = previousRotationBytes;
  }
  await fs.rm(tempDir, { recursive: true, force: true });
}
