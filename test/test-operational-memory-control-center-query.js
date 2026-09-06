/** RED -> GREEN coverage for M6 read-only Operational Memory overview. */
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

let DatabaseSync;
try { ({ DatabaseSync } = await import('node:sqlite')); }
catch { console.log('SKIP M6 Memory query: node:sqlite unavailable'); process.exit(0); }

const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'dc-memory-m6-query-'));
const stateRoot = path.join(tempDir, 'state');
const previousStateRoot = process.env.DESKTOP_COMMANDER_WORKFLOW_STATE_DIR;
process.env.DESKTOP_COMMANDER_WORKFLOW_STATE_DIR = stateRoot;

const ids = {
  healthyA: 'aaaaaaaaaaaaaaaaaaaaaaaa',
  healthyB: 'bbbbbbbbbbbbbbbbbbbbbbbb',
  healthyC: '999999999999999999999999',
  stale: 'cccccccccccccccccccccccc',
  missing: 'dddddddddddddddddddddddd',
  corrupt: 'eeeeeeeeeeeeeeeeeeeeeeee',
  orphaned: 'ffffffffffffffffffffffff',
};

function memoryPath(id) { return path.join(stateRoot, `${id}.memory.jsonl`); }
function indexPath(id) { return path.join(stateRoot, `${id}.memory.sqlite`); }
function createSchema(db) {
  db.exec(`
    CREATE TABLE events (
      record_sequence INTEGER PRIMARY KEY,
      start_offset INTEGER NOT NULL,
      end_offset INTEGER NOT NULL,
      workflow_id TEXT NOT NULL,
      task_id TEXT,
      run_id TEXT,
      kind TEXT NOT NULL,
      reason_code TEXT NOT NULL,
      lesson_code TEXT,
      source_tool TEXT NOT NULL,
      family TEXT NOT NULL,
      stage_id TEXT,
      fingerprint TEXT NOT NULL,
      occurred_at TEXT NOT NULL
    );
    CREATE TABLE groups (
      workflow_id TEXT NOT NULL,
      fingerprint TEXT NOT NULL,
      kind TEXT NOT NULL,
      reason_code TEXT NOT NULL,
      lesson_code TEXT,
      source_tool TEXT NOT NULL,
      family TEXT NOT NULL,
      stage_id TEXT,
      first_seen_at TEXT NOT NULL,
      last_seen_at TEXT NOT NULL,
      occurrences INTEGER NOT NULL,
      latest_record_sequence INTEGER NOT NULL,
      PRIMARY KEY (workflow_id, fingerprint)
    );
  `);
}
function createAggregateSchema(db) {
  db.exec(`
    CREATE TABLE project_groups (
      fingerprint TEXT PRIMARY KEY,
      kind TEXT NOT NULL,
      reason_code TEXT NOT NULL,
      lesson_code TEXT,
      source_tool TEXT NOT NULL,
      family TEXT NOT NULL,
      stage_id TEXT,
      first_seen_at TEXT NOT NULL,
      last_seen_at TEXT NOT NULL,
      occurrences INTEGER NOT NULL,
      distinct_workflows INTEGER NOT NULL,
      latest_workflow_id TEXT NOT NULL,
      latest_record_sequence INTEGER NOT NULL
    );
    CREATE TABLE index_state (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      schema_version INTEGER NOT NULL,
      indexed_through_offset INTEGER NOT NULL,
      authority_size_bytes INTEGER NOT NULL,
      authority_mtime_ms REAL NOT NULL,
      authority_ctime_ms REAL NOT NULL,
      record_count INTEGER NOT NULL,
      project_id TEXT,
      repository_id TEXT,
      authority_chain_hash TEXT NOT NULL,
      rebuild_status TEXT NOT NULL
    );
  `);
}
async function createJournal(id, label) {
  const target = memoryPath(id);
  await fs.writeFile(target, JSON.stringify({ fixture: label }) + '\n');
  return fs.stat(target);
}

function createIndex(id, journalStat, { projectId, events = [], staleSizeDelta = 0 }) {
  const target = indexPath(id);
  const db = new DatabaseSync(target);
  createSchema(db);
  createAggregateSchema(db);
  const insertEvent = db.prepare(`
    INSERT INTO events (
      record_sequence, start_offset, end_offset, workflow_id, task_id, run_id,
      kind, reason_code, lesson_code, source_tool, family, stage_id, fingerprint, occurred_at
    ) VALUES (?, ?, ?, ?, NULL, NULL, ?, ?, ?, ?, ?, NULL, ?, ?)
  `);
  events.forEach((event, index) => insertEvent.run(
    index + 1, index * 10, (index + 1) * 10, `workflow-${id}`,
    event.kind, event.reasonCode, event.lessonCode ?? null,
    event.sourceTool ?? 'project_workflow', event.family ?? 'workflow',
    event.fingerprint, event.occurredAt,
  ));
  db.prepare(`
    INSERT INTO index_state (
      id, schema_version, indexed_through_offset, authority_size_bytes,
      authority_mtime_ms, authority_ctime_ms, record_count, project_id,
      repository_id, authority_chain_hash, rebuild_status
    ) VALUES (1, 5, ?, ?, ?, ?, ?, ?, ?, 'fixture-chain', 'ready')
  `).run(
    journalStat?.size ?? 0,
    (journalStat?.size ?? 0) + staleSizeDelta,
    journalStat?.mtimeMs ?? 0,
    journalStat?.ctimeMs ?? 0,
    events.length,
    projectId ?? null,
    projectId ? `repo-${projectId}` : null,
  );
  db.close();
}

function seedGroups(id, { workflowGroups = [], projectGroups = [] }) {
  const db = new DatabaseSync(indexPath(id));
  const insertWorkflow = db.prepare(`
    INSERT INTO groups (
      workflow_id, fingerprint, kind, reason_code, lesson_code, source_tool, family,
      stage_id, first_seen_at, last_seen_at, occurrences, latest_record_sequence
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  workflowGroups.forEach((row, index) => insertWorkflow.run(
    row.workflowId, row.fingerprint, row.kind, row.reasonCode, row.lessonCode ?? null,
    row.sourceTool, row.family, row.stageId ?? null, row.firstSeenAt, row.lastSeenAt,
    row.occurrences, index + 1,
  ));
  const insertProject = db.prepare(`
    INSERT INTO project_groups (
      fingerprint, kind, reason_code, lesson_code, source_tool, family, stage_id,
      first_seen_at, last_seen_at, occurrences, distinct_workflows,
      latest_workflow_id, latest_record_sequence
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  projectGroups.forEach((row, index) => insertProject.run(
    row.fingerprint, row.kind, row.reasonCode, row.lessonCode ?? null,
    row.sourceTool, row.family, row.stageId ?? null, row.firstSeenAt, row.lastSeenAt,
    row.occurrences, row.distinctWorkflows, row.latestWorkflowId, index + 1,
  ));  db.close();
}
function createGlobalIndex(rows) {
  const target = path.join(stateRoot, 'operational-memory.global.sqlite');
  const db = new DatabaseSync(target);
  db.exec(`
    CREATE TABLE global_sources (
      source_id TEXT PRIMARY KEY, project_key TEXT NOT NULL,
      authority_size_bytes INTEGER NOT NULL, authority_mtime_ms REAL NOT NULL,
      authority_ctime_ms REAL NOT NULL
    );
    CREATE TABLE global_project_lessons (
      project_key TEXT NOT NULL, fingerprint TEXT NOT NULL, lesson_code TEXT NOT NULL,
      first_seen_at TEXT NOT NULL, last_seen_at TEXT NOT NULL, occurrences INTEGER NOT NULL,
      PRIMARY KEY (project_key, fingerprint)
    );
    CREATE TABLE global_state (id INTEGER PRIMARY KEY CHECK (id = 1), schema_version INTEGER NOT NULL);
    INSERT INTO global_state (id, schema_version) VALUES (1, 1);
  `);
  const insert = db.prepare(`
    INSERT INTO global_project_lessons (
      project_key, fingerprint, lesson_code, first_seen_at, last_seen_at, occurrences
    ) VALUES (?, ?, ?, ?, ?, ?)
  `);
  for (const row of rows) insert.run(
    row.projectKey, row.fingerprint, row.lessonCode, row.firstSeenAt, row.lastSeenAt, row.occurrences,
  );
  db.close();
}

async function snapshotStateFiles() {
  const names = (await fs.readdir(stateRoot)).sort();
  const snapshot = new Map();
  for (const name of names) {
    const target = path.join(stateRoot, name);
    const stat = await fs.stat(target);
    if (!stat.isFile()) continue;
    snapshot.set(name, { bytes: await fs.readFile(target), mtimeMs: stat.mtimeMs });
  }
  return snapshot;
}
async function assertSnapshotUnchanged(before) {
  const after = await snapshotStateFiles();
  assert.deepEqual([...after.keys()], [...before.keys()], 'query must not create/delete state files');
  for (const [name, previous] of before) {
    const current = after.get(name);
    assert.deepEqual(current.bytes, previous.bytes, `${name} bytes must remain unchanged`);
    assert.equal(current.mtimeMs, previous.mtimeMs, `${name} mtime must remain unchanged`);
  }
}

try {
  await fs.mkdir(stateRoot, { recursive: true });
  const first = '2026-09-05T10:00:00.000Z';
  const second = '2026-09-05T11:00:00.000Z';
  const third = '2026-09-05T12:00:00.000Z';
  const projectId = 'project-shared';

  const healthyAStat = await createJournal(ids.healthyA, 'healthy-a');
  createIndex(ids.healthyA, healthyAStat, { projectId, events: [
    { kind: 'error', reasonCode: 'not_found', fingerprint: 'fp-error', occurredAt: first },
    { kind: 'lesson', reasonCode: 'learned_pattern', lessonCode: 'tooling_availability_check', fingerprint: 'fp-lesson', occurredAt: second },
  ] });

  const healthyBStat = await createJournal(ids.healthyB, 'healthy-b');
  createIndex(ids.healthyB, healthyBStat, { projectId, events: [
    { kind: 'limit', reasonCode: 'timeout', fingerprint: 'fp-limit', occurredAt: third },
  ] });
  const staleStat = await createJournal(ids.stale, 'stale');
  createIndex(ids.stale, staleStat, {
    projectId: 'project-stale', staleSizeDelta: 1,
    events: [{ kind: 'error', reasonCode: 'not_found', fingerprint: 'fp-stale', occurredAt: third }],
  });

  await createJournal(ids.missing, 'missing-index');
  await createJournal(ids.corrupt, 'corrupt-index');
  await fs.writeFile(indexPath(ids.corrupt), 'not a sqlite database', 'utf8');
  createIndex(ids.orphaned, null, {
    projectId: 'project-orphaned',
    events: [{ kind: 'error', reasonCode: 'not_found', fingerprint: 'fp-orphan', occurredAt: third }],
  });

  const before = await snapshotStateFiles();
  const memoryQuery = await import('../dist/workflow/operational-memory-query.js');
  const overview = await memoryQuery.getOperationalMemoryOverview();

  assert.equal(overview.projectsWithMemory, 1, 'linked/same-project indexes must dedupe by ProjectId');
  assert.equal(overview.totalEvents, 3, 'only healthy indexes contribute query-derived event counts');
  assert.equal(overview.uniqueFingerprints, 3);
  assert.deepEqual(overview.countsByKind, { error: 1, limit: 1, lesson: 1 });
  assert.equal(overview.lastActivityAt, third);
  assert.ok(overview.journalBytes > 0);
  assert.ok(overview.indexBytes > 0);
  assert.equal(overview.indexHealth.overall, 'degraded');
  assert.deepEqual(
    {
      healthy: overview.indexHealth.healthy,
      stale: overview.indexHealth.stale,
      missing: overview.indexHealth.missing,
      corrupt: overview.indexHealth.corrupt,
      orphaned: overview.indexHealth.orphaned,
    },
    { healthy: 2, stale: 1, missing: 1, corrupt: 1, orphaned: 1 },
  );
  assert.ok(overview.generatedAt);
  const serialized = JSON.stringify(overview);
  for (const forbidden of [tempDir, stateRoot, projectId, 'healthy-a', 'project-stale']) {
    assert.ok(!serialized.includes(forbidden), `overview must not expose ${forbidden}`);
  }
  await assertSnapshotUnchanged(before);
  console.log('âś… Operational Memory M6 read-only overview tests passed');
  seedGroups(ids.healthyA, {
    workflowGroups: [
      { workflowId: 'workflow-a1', fingerprint: 'fp-shared', kind: 'error', reasonCode: 'not_found', sourceTool: 'read_file', family: 'filesystem', stageId: 'inspect', firstSeenAt: first, lastSeenAt: second, occurrences: 2 },
      { workflowId: 'workflow-a2', fingerprint: 'fp-shared', kind: 'error', reasonCode: 'not_found', sourceTool: 'read_file', family: 'filesystem', stageId: 'inspect', firstSeenAt: second, lastSeenAt: '2026-09-05T12:30:00.000Z', occurrences: 1 },
      { workflowId: 'workflow-a1', fingerprint: 'fp-lesson', kind: 'lesson', reasonCode: 'learned_pattern', lessonCode: 'tooling_availability_check', sourceTool: 'project_workflow', family: 'workflow', stageId: 'learn', firstSeenAt: first, lastSeenAt: second, occurrences: 1 },
    ],
    projectGroups: [
      { fingerprint: 'fp-shared', kind: 'error', reasonCode: 'not_found', sourceTool: 'read_file', family: 'filesystem', stageId: 'inspect', firstSeenAt: first, lastSeenAt: '2026-09-05T12:30:00.000Z', occurrences: 3, distinctWorkflows: 2, latestWorkflowId: 'workflow-a2' },
      { fingerprint: 'fp-lesson', kind: 'lesson', reasonCode: 'learned_pattern', lessonCode: 'tooling_availability_check', sourceTool: 'project_workflow', family: 'workflow', stageId: 'learn', firstSeenAt: first, lastSeenAt: second, occurrences: 1, distinctWorkflows: 1, latestWorkflowId: 'workflow-a1' },
    ],
  });
  seedGroups(ids.healthyB, {
    workflowGroups: [
      { workflowId: 'workflow-b1', fingerprint: 'fp-shared', kind: 'error', reasonCode: 'not_found', sourceTool: 'read_file', family: 'filesystem', stageId: 'inspect', firstSeenAt: second, lastSeenAt: '2026-09-05T13:00:00.000Z', occurrences: 4 },
    ],
    projectGroups: [
      { fingerprint: 'fp-shared', kind: 'error', reasonCode: 'not_found', sourceTool: 'read_file', family: 'filesystem', stageId: 'inspect', firstSeenAt: second, lastSeenAt: '2026-09-05T13:00:00.000Z', occurrences: 4, distinctWorkflows: 1, latestWorkflowId: 'workflow-b1' },
    ],
  });

  const otherProjectId = 'project-other';
  const healthyCStat = await createJournal(ids.healthyC, 'healthy-c');
  createIndex(ids.healthyC, healthyCStat, { projectId: otherProjectId, events: [] });
  const bulkGroups = Array.from({ length: 205 }, (_, index) => ({
    fingerprint: `bulk-${String(index).padStart(3, '0')}`, kind: 'error',
    reasonCode: 'validation_error', sourceTool: 'write_file', family: 'filesystem', stageId: 'review',
    firstSeenAt: third, lastSeenAt: third, occurrences: 1,
    distinctWorkflows: 1, latestWorkflowId: `bulk-workflow-${index}`,
  }));
  seedGroups(ids.healthyC, { projectGroups: bulkGroups });
  createGlobalIndex([
    { projectKey: 'global-project-a', fingerprint: 'fp-global', lessonCode: 'tooling_availability_check', firstSeenAt: first, lastSeenAt: '2026-09-05T16:00:00.000Z', occurrences: 3 },
    { projectKey: 'global-project-b', fingerprint: 'fp-global', lessonCode: 'tooling_availability_check', firstSeenAt: second, lastSeenAt: '2026-09-05T17:00:00.000Z', occurrences: 2 },
    { projectKey: 'global-project-b', fingerprint: 'fp-invalid-global', lessonCode: 'PRIVATE_INVALID_LESSON_CODE', firstSeenAt: first, lastSeenAt: third, occurrences: 99 },
  ]);
  const groupBefore = await snapshotStateFiles();

  const projectPage = await memoryQuery.queryOperationalMemoryGroups({
    scope: 'project', projectId, fingerprint: 'fp-shared', kind: 'error',
    reasonCode: 'not_found', sourceTool: 'read_file', family: 'filesystem', stageId: 'inspect',
    from: '2026-09-05T12:00:00.000Z', to: '2026-09-05T13:30:00.000Z',
    minOccurrences: 7, limit: 1,
  });
  assert.equal(projectPage.items.length, 1);
  assert.equal(projectPage.items[0].projectId, projectId);
  assert.equal(projectPage.items[0].scope, 'project');
  assert.equal(projectPage.items[0].fingerprint, 'fp-shared');
  assert.equal(projectPage.items[0].occurrences, 7);
  assert.equal(projectPage.items[0].distinctWorkflows, 3);
  assert.ok(projectPage.items[0].title.includes('read_file'));
  assert.ok(projectPage.items[0].lesson.length > 0);

  const lessonPage = await memoryQuery.queryOperationalMemoryGroups({
    scope: 'project', projectId, lessonCode: 'tooling_availability_check', limit: 10,
  });
  assert.equal(lessonPage.items.length, 1);
  assert.equal(lessonPage.items[0].fingerprint, 'fp-lesson');
  const workflowSeen = [];
  let workflowCursor;
  do {
    const page = await memoryQuery.queryOperationalMemoryGroups({
      scope: 'workflow', projectId, fingerprint: 'fp-shared', limit: 1,
      ...(workflowCursor ? { cursor: workflowCursor } : {}),
    });
    workflowSeen.push(...page.items.map((item) => item.workflowId));
    workflowCursor = page.nextCursor;
  } while (workflowCursor);
  assert.deepEqual(workflowSeen.sort(), ['workflow-a1', 'workflow-a2', 'workflow-b1']);

  const capped = await memoryQuery.queryOperationalMemoryGroups({
    scope: 'project', projectId: otherProjectId, limit: 999,
  });
  assert.equal(capped.items.length, 200, 'group page hard cap must be 200');
  assert.ok(capped.nextCursor);
  const cappedSecond = await memoryQuery.queryOperationalMemoryGroups({
    scope: 'project', projectId: otherProjectId, limit: 200, cursor: capped.nextCursor,
  });
  assert.equal(cappedSecond.items.length, 5);
  const fingerprints = [...capped.items, ...cappedSecond.items].map((item) => item.fingerprint);
  assert.equal(new Set(fingerprints).size, 205, 'cursor continuation must not duplicate groups');
  await assert.rejects(
    () => memoryQuery.queryOperationalMemoryGroups({ scope: 'project', cursor: 'not-a-valid-cursor' }),
    /Invalid memory cursor/,
  );
  const globalPage = await memoryQuery.queryOperationalMemoryGroups({ scope: 'global', limit: 10 });
  assert.equal(globalPage.items.length, 1, 'only valid M3B-whitelisted global lessons are browseable');
  assert.equal(globalPage.items[0].scope, 'global');
  assert.equal(globalPage.items[0].projectId, undefined);
  assert.equal(globalPage.items[0].fingerprint, 'fp-global');
  assert.equal(globalPage.items[0].lessonCode, 'tooling_availability_check');
  assert.equal(globalPage.items[0].occurrences, 5);
  assert.equal(globalPage.items[0].distinctProjects, 2);
  assert.ok(!JSON.stringify(globalPage).includes('PRIVATE_INVALID_LESSON_CODE'));

  const options = await memoryQuery.getOperationalMemoryFilterOptions();
  assert.ok(options.projects.some((project) => project.projectId === projectId));
  assert.ok(options.projects.some((project) => project.projectId === otherProjectId));
  assert.deepEqual(options.kinds, ['error', 'limit', 'lesson']);
  assert.ok(options.reasonCodes.includes('not_found'));
  assert.ok(options.reasonCodes.includes('learned_pattern'));
  assert.ok(options.lessonCodes.includes('tooling_availability_check'));
  assert.ok(options.sourceTools.includes('read_file'));
  assert.ok(options.families.includes('filesystem'));
  assert.ok(options.stageIds.includes('inspect'));
  assert.ok(!JSON.stringify(options).includes('PRIVATE_INVALID_LESSON_CODE'));

  await assertSnapshotUnchanged(groupBefore);
  console.log('âś… Operational Memory M6 group/filter/global tests passed');
} finally {
  if (previousStateRoot === undefined) delete process.env.DESKTOP_COMMANDER_WORKFLOW_STATE_DIR;
  else process.env.DESKTOP_COMMANDER_WORKFLOW_STATE_DIR = previousStateRoot;
  await fs.rm(tempDir, { recursive: true, force: true });
}
