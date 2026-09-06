/** M6 100k-event indexed navigation, privacy, and non-mutation exit gate. */
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { performance } from 'node:perf_hooks';

if (typeof global.gc !== 'function') {
  console.log('SKIP M6 scale: dedicated gate requires node --expose-gc test/test-operational-memory-control-center-scale.js');
  process.exit(0);
}

let DatabaseSync;
try { ({ DatabaseSync } = await import('node:sqlite')); }
catch { console.log('SKIP M6 scale: node:sqlite unavailable'); process.exit(0); }

import * as workflow from '../dist/workflow/project-workflow.js';
import * as storage from '../dist/workflow/workflow-storage.js';
import * as globalIndex from '../dist/workflow/operational-memory-global-index.js';
import {
  getOperationalMemoryFilterOptions,
  getOperationalMemoryOverview,
  queryOperationalMemoryEvents,
  queryOperationalMemoryGroups,
} from '../dist/workflow/operational-memory-query.js';

const EVENT_COUNT = 100_000;
const CLONE_COUNT = EVENT_COUNT - 3;
const PAGE_LIMIT = 50;
const SAMPLE_COUNT = 20;
const SMALL_PAGE_P95_MS = 120;
const HOT_FILTER_P95_MS = 150;
const MAX_HEAP_GROWTH = 80 * 1024 * 1024;
const BASE_TIME_MS = Date.UTC(2026, 8, 1, 0, 0, 0);
const OUT_OF_ORDER_MAX_TIME = '2099-01-01T00:00:00.000Z';
const PRIVACY_MARKERS = [
  'FAKE_API_KEY_SECRET', 'PRIVATE_COMMAND', 'PRIVATE_FILE_CONTENT',
  'PRIVATE_MCP_ARGS', 'PRIVATE_APPROVAL_PAYLOAD',
];

function git(root, ...args) {
  return execFileSync('git', ['-C', root, ...args], { encoding: 'utf8' }).trim();
}

async function initRepo(root, origin, profileId) {
  await fs.mkdir(path.join(root, '.desktop-commander'), { recursive: true });
  await fs.writeFile(path.join(root, '.desktop-commander', 'project-workflow.json'), JSON.stringify({
    version: 1,
    id: profileId,
    name: profileId,
    stages: [{ id: 'inspect', label: 'Inspect', required: true }],
  }, null, 2));
  execFileSync('git', ['init', root]);
  git(root, 'config', 'user.email', 'm6-scale@example.invalid');
  git(root, 'config', 'user.name', 'M6 Scale Test');
  git(root, 'remote', 'add', 'origin', origin);
  await fs.writeFile(path.join(root, 'README.md'), `# ${profileId}\n`);
  git(root, 'add', '.');
  git(root, 'commit', '-m', 'baseline');
}

async function recordNotFound(projectRoot) {
  const recorded = await workflow.recordOperationalToolFailure({
    tool: 'read_file',
    args: { path: path.join(projectRoot, 'missing.txt') },
    result: { content: [{ type: 'text', text: 'Error: ENOENT missing resource' }], isError: true },
  });
  assert.equal(recorded, true, 'ordinary not-found failure should be recorded');
}

async function readJournalEvents(memoryPath) {
  return (await fs.readFile(memoryPath, 'utf8')).trim().split(/\r?\n/)
    .filter(Boolean).flatMap((line) => {
      try { return [JSON.parse(line)]; } catch { return []; }
    });
}

function cloneEvent(seed, index) {
  return {
    ...seed,
    id: `10000000-0000-4000-8000-${String(index).padStart(12, '0')}`,
    occurredAt: index === 2 ? OUT_OF_ORDER_MAX_TIME : new Date(BASE_TIME_MS + index).toISOString(),
    ...(index === 1 ? {
      summary: PRIVACY_MARKERS.slice(0, 3).join('|'),
      lesson: PRIVACY_MARKERS.slice(3).join('|'),
    } : {}),
  };
}

async function appendScaleClones(memoryPath, lessonSeed, failureSeed) {
  const chunkSize = 1_000;
  for (let start = 0; start < CLONE_COUNT; start += chunkSize) {
    const lines = [];
    const end = Math.min(CLONE_COUNT, start + chunkSize);
    for (let index = start; index < end; index += 1) {
      const seed = index % 2 === 0 ? lessonSeed : failureSeed;
      lines.push(JSON.stringify(cloneEvent(seed, index + 1)));
    }
    await fs.appendFile(memoryPath, lines.join('\n') + '\n', 'utf8');
  }
}

async function snapshotMemoryFiles(stateRoot) {
  const names = (await fs.readdir(stateRoot)).filter((name) =>
    name.endsWith('.memory.jsonl') ||
    name.endsWith('.memory.sqlite') ||
    name === 'operational-memory.global.sqlite'
  ).sort();
  const snapshots = [];
  for (const name of names) {
    const filePath = path.join(stateRoot, name);
    const [bytes, stat] = await Promise.all([fs.readFile(filePath), fs.stat(filePath)]);
    snapshots.push({ name, bytes, size: stat.size, mtimeMs: stat.mtimeMs });
  }
  return snapshots;
}

function assertSnapshotsEqual(after, before) {
  assert.deepEqual(after.map(({ name, size, mtimeMs }) => ({ name, size, mtimeMs })),
    before.map(({ name, size, mtimeMs }) => ({ name, size, mtimeMs })),
    'M6 reads must preserve memory file names, sizes, and mtimes');
  assert.equal(after.length, before.length);
  for (let index = 0; index < before.length; index += 1) {
    assert.equal(after[index].bytes.equals(before[index].bytes), true,
      `M6 read path mutated bytes for ${before[index].name}`);
  }
}

function percentile95(samples) {
  const sorted = [...samples].sort((a, b) => a - b);
  return sorted[Math.ceil(sorted.length * 0.95) - 1];
}

async function measure(name, operation) {
  await operation();
  const samples = [];
  let result;
  for (let index = 0; index < SAMPLE_COUNT; index += 1) {
    const startedAt = performance.now();
    result = await operation();
    samples.push(performance.now() - startedAt);
  }
  const p95Ms = percentile95(samples);
  console.log(JSON.stringify({ metric: 'm6_scale', operation: name,
    samples: SAMPLE_COUNT, p95Ms: Number(p95Ms.toFixed(3)), maxMs: Number(Math.max(...samples).toFixed(3)) }));
  return { result, p95Ms };
}

function measureSql(db, name, sql, params = []) {
  const stmt = db.prepare(sql);
  stmt.all(...params);
  const samples = [];
  for (let index = 0; index < SAMPLE_COUNT; index += 1) {
    const startedAt = performance.now();
    stmt.all(...params);
    samples.push(performance.now() - startedAt);
  }
  console.log(JSON.stringify({ metric: 'm6_sql_profile', operation: name,
    p95Ms: Number(percentile95(samples).toFixed(3)), maxMs: Number(Math.max(...samples).toFixed(3)) }));
}

function printQueryPlans(indexPath, fingerprint) {
  const db = new DatabaseSync(indexPath, { readOnly: true });
  try {
    const plans = {
      healthAggregate: db.prepare(`EXPLAIN QUERY PLAN SELECT COUNT(*) AS total,
        SUM(CASE WHEN kind = 'error' THEN 1 ELSE 0 END) AS errors,
        SUM(CASE WHEN kind = 'limit' THEN 1 ELSE 0 END) AS limits,
        SUM(CASE WHEN kind = 'lesson' THEN 1 ELSE 0 END) AS lessons,
        MAX(occurred_at) AS last_activity FROM events`).all(),
      fingerprintAggregate: db.prepare(
        'EXPLAIN QUERY PLAN SELECT fingerprint FROM events GROUP BY fingerprint ORDER BY fingerprint'
      ).all(),
      projectLessonGroups: db.prepare(
        'EXPLAIN QUERY PLAN SELECT * FROM project_groups WHERE kind = ?'
      ).all('lesson'),
      projectFingerprint: db.prepare(
        'EXPLAIN QUERY PLAN SELECT * FROM project_groups WHERE fingerprint = ?'
      ).all(fingerprint),
      eventJoin: db.prepare(`EXPLAIN QUERY PLAN
        SELECT e.record_sequence, e.workflow_id, e.task_id, e.run_id, e.kind,
          e.reason_code, e.lesson_code, e.source_tool, e.family, e.stage_id,
          e.fingerprint, e.occurred_at
        FROM groups g JOIN events e
          ON e.workflow_id = g.workflow_id AND e.fingerprint = g.fingerprint
        WHERE g.fingerprint = ?
        ORDER BY e.occurred_at DESC, e.workflow_id ASC, e.record_sequence DESC
        LIMIT ?`).all(fingerprint, PAGE_LIMIT + 1),
    };
    for (const [operation, plan] of Object.entries(plans)) {
      console.log(JSON.stringify({ metric: 'm6_query_plan', operation, plan }));
    }
    measureSql(db, 'eventCountOnly', 'SELECT COUNT(*) AS total FROM events');
    measureSql(db, 'eventAggregateCurrent', "SELECT COUNT(*) AS total, SUM(CASE WHEN kind='error' THEN 1 ELSE 0 END) AS errors, SUM(CASE WHEN kind='limit' THEN 1 ELSE 0 END) AS limits, SUM(CASE WHEN kind='lesson' THEN 1 ELSE 0 END) AS lessons, MAX(occurred_at) AS last_activity FROM events");
    measureSql(db, 'eventLastActivityOnly', 'SELECT MAX(occurred_at) AS last_activity FROM events');
    measureSql(db, 'eventFingerprintsCurrent', 'SELECT fingerprint FROM events GROUP BY fingerprint ORDER BY fingerprint');
    measureSql(db, 'projectGroupAggregate', "SELECT COALESCE(SUM(occurrences),0) AS total, COALESCE(SUM(CASE WHEN kind='error' THEN occurrences ELSE 0 END),0) AS errors, COALESCE(SUM(CASE WHEN kind='limit' THEN occurrences ELSE 0 END),0) AS limits, COALESCE(SUM(CASE WHEN kind='lesson' THEN occurrences ELSE 0 END),0) AS lessons FROM project_groups");
    measureSql(db, 'projectGroupFingerprints', 'SELECT fingerprint FROM project_groups ORDER BY fingerprint');
    measureSql(db, 'eventJoinCurrent', "SELECT e.record_sequence, e.workflow_id, e.task_id, e.run_id, e.kind, e.reason_code, e.lesson_code, e.source_tool, e.family, e.stage_id, e.fingerprint, e.occurred_at FROM groups g JOIN events e ON e.workflow_id=g.workflow_id AND e.fingerprint=g.fingerprint WHERE g.fingerprint=? ORDER BY e.occurred_at DESC, e.workflow_id ASC, e.record_sequence DESC LIMIT ?", [fingerprint, PAGE_LIMIT + 1]);
    measureSql(db, 'eventDirectCandidate', "SELECT e.record_sequence, e.workflow_id, e.task_id, e.run_id, e.kind, e.reason_code, e.lesson_code, e.source_tool, e.family, e.stage_id, e.fingerprint, e.occurred_at FROM events e WHERE e.fingerprint=? ORDER BY e.occurred_at DESC, e.workflow_id ASC, e.record_sequence DESC LIMIT ?", [fingerprint, PAGE_LIMIT + 1]);
    const continuationTime = new Date(BASE_TIME_MS + EVENT_COUNT - 100).toISOString();
    measureSql(db, 'eventDirectContinuationCandidate', "SELECT e.record_sequence, e.workflow_id, e.task_id, e.run_id, e.kind, e.reason_code, e.lesson_code, e.source_tool, e.family, e.stage_id, e.fingerprint, e.occurred_at FROM events e WHERE e.fingerprint=? AND e.occurred_at < ? ORDER BY e.occurred_at DESC, e.workflow_id ASC, e.record_sequence DESC LIMIT ?", [fingerprint, continuationTime, PAGE_LIMIT + 1]);
  } finally {
    db.close();
  }
}

function assertEventOrderPlan(indexPath, fingerprint) {
  const db = new DatabaseSync(indexPath, { readOnly: true });
  try {
    const sql = `EXPLAIN QUERY PLAN SELECT e.record_sequence, e.workflow_id, e.occurred_at FROM events e
      WHERE e.fingerprint = ? AND EXISTS (SELECT 1 FROM groups g WHERE g.workflow_id = e.workflow_id AND g.fingerprint = e.fingerprint)
      ORDER BY e.occurred_at DESC, e.workflow_id ASC, e.record_sequence DESC LIMIT ?`;
    const details = db.prepare(sql).all(fingerprint, PAGE_LIMIT + 1).map((row) => String(row.detail));
    assert.ok(details.some((detail) => detail.includes('events_fingerprint_order')), 'first-page plan must use event-order helper index');
    assert.equal(details.some((detail) => detail.includes('USE TEMP B-TREE FOR ORDER BY')), false, 'first-page plan must stream order without temp B-tree');
  } finally { db.close(); }
}

function assertPrivacySafe(label, value, extraForbidden = []) {
  const serialized = JSON.stringify(value);
  for (const marker of [...PRIVACY_MARKERS, ...extraForbidden]) {
    assert.equal(serialized.includes(marker), false, `${label} leaked forbidden marker: ${marker}`);
  }
}

function eventKey(item) {
  return [item.projectId ?? '', item.workflowId, item.fingerprint, item.occurredAt].join('|');
}

const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'dc-memory-m6-scale-'));
const primary = path.join(tempDir, 'primary');
const linked = path.join(tempDir, 'linked');
const other = path.join(tempDir, 'other');
const stateRoot = path.join(tempDir, 'state');
const previousStateRoot = process.env.DESKTOP_COMMANDER_WORKFLOW_STATE_DIR;
process.env.DESKTOP_COMMANDER_WORKFLOW_STATE_DIR = stateRoot;

try {
  await initRepo(primary, 'https://github.com/example/m6-scale-primary.git', 'm6-scale-primary');
  await initRepo(other, 'https://github.com/example/m6-scale-other.git', 'm6-scale-other');

  const primaryStart = await workflow.startProjectWorkflow({
    projectRoot: primary, goal: 'M6 100k scale fixture',
  });
  assert.equal(await workflow.recordOperationalLesson({
    projectRoot: primary, lessonCode: 'fetch_required_git_refs',
  }), true);
  await recordNotFound(primary);

  const memoryPath = storage.resolveWorkflowMemoryPath(primary);
  const primaryIndexPath = storage.resolveWorkflowMemoryIndexPath(primary);
  await workflow.getProjectWorkflowStatus({ projectRoot: primary });
  const seeds = await readJournalEvents(memoryPath);
  const lessonSeed = seeds.find((event) => event.lessonCode === 'fetch_required_git_refs');
  const failureSeed = seeds.find((event) => event.reasonCode === 'not_found');
  assert.ok(lessonSeed, 'real lesson seed must exist');
  assert.ok(failureSeed, 'real ordinary-failure seed must exist');
  assert.notEqual(lessonSeed.fingerprint, failureSeed.fingerprint);

  await appendScaleClones(memoryPath, lessonSeed, failureSeed);
  await recordNotFound(primary);
  const primaryDb = new DatabaseSync(primaryIndexPath, { readOnly: true });
  let primaryEvents;
  let indexState;
  try {
    primaryEvents = Number(primaryDb.prepare('SELECT COUNT(*) AS count FROM events').get().count);
    indexState = primaryDb.prepare('SELECT * FROM index_state WHERE id = 1').get();
  } finally {
    primaryDb.close();
  }
  const primaryJournalStat = await fs.stat(memoryPath);
  assert.equal(primaryEvents, EVENT_COUNT, 'primary scale project must contain exactly 100,000 valid indexed events');
  assert.equal(Number(indexState.authority_size_bytes), primaryJournalStat.size,
    'primary index must be synchronized to the full journal before M6 timing');
  assert.equal(Number(indexState.authority_mtime_ms), primaryJournalStat.mtimeMs,
    'primary index authority mtime must match before M6 timing');
  assertEventOrderPlan(primaryIndexPath, lessonSeed.fingerprint);

  git(primary, 'worktree', 'add', '--detach', linked, 'HEAD');
  const linkedStart = await workflow.startProjectWorkflow({ projectRoot: linked, goal: 'M6 linked worktree' });
  assert.equal(linkedStart.projectIdentity.projectId, primaryStart.projectIdentity.projectId,
    'linked worktree must resolve to the same stable ProjectId');
  assert.equal(await workflow.recordOperationalLesson({
    projectRoot: linked, lessonCode: 'fetch_required_git_refs',
  }), true);
  await workflow.getProjectWorkflowStatus({ projectRoot: linked });

  const otherStart = await workflow.startProjectWorkflow({ projectRoot: other, goal: 'M6 unrelated project' });
  assert.notEqual(otherStart.projectIdentity.projectId, primaryStart.projectIdentity.projectId);
  assert.equal(await workflow.recordOperationalLesson({
    projectRoot: other, lessonCode: 'fetch_required_git_refs',
  }), true);
  await recordNotFound(other);
  await workflow.getProjectWorkflowStatus({ projectRoot: other });
  const projectId = primaryStart.projectIdentity.projectId;
  const lessonFingerprint = lessonSeed.fingerprint;
  const failureFingerprint = failureSeed.fingerprint;
  const globalIndexPath = globalIndex.resolveOperationalMemoryGlobalIndexPath();
  assert.equal(await fs.stat(globalIndexPath).then((stat) => stat.isFile(), () => false), true,
    'normal runtime setup must create the derived Global index before M6 reads');

  const beforeReads = await snapshotMemoryFiles(stateRoot);
  assert.ok(beforeReads.some((item) => item.name === path.basename(globalIndexPath)),
    'non-mutation snapshot must include the Global derived index');

  const preflightOverview = await getOperationalMemoryOverview();
  console.log(JSON.stringify({ metric: 'm6_preflight_health', ...preflightOverview.indexHealth }));
  assert.equal(preflightOverview.indexHealth.overall, 'healthy');
  assert.equal(preflightOverview.indexHealth.healthy, 3,
    'primary, linked-worktree, and unrelated-project indexes must all be healthy');
  assert.ok(preflightOverview.totalEvents >= EVENT_COUNT,
    'overview must include the 100k primary fixture');
  assert.equal(preflightOverview.lastActivityAt, OUT_OF_ORDER_MAX_TIME,
    'overview must preserve MAX(events.occurred_at) even when later-ingested events have older timestamps');

  const filterOptions = await getOperationalMemoryFilterOptions();
  assert.equal(filterOptions.projects.length, 2,
    'linked worktrees must dedupe to one ProjectId in filter options');
  assert.ok(filterOptions.kinds.includes('lesson'));
  assert.ok(filterOptions.kinds.includes('error'));
  assertPrivacySafe('filter options', filterOptions);

  const projectExactPreflight = await queryOperationalMemoryGroups({
    scope: 'project', projectId, fingerprint: lessonFingerprint, limit: PAGE_LIMIT,
  });
  assert.equal(projectExactPreflight.items.length, 1);
  assert.equal(projectExactPreflight.items[0].projectId, projectId);
  assert.equal(projectExactPreflight.items[0].fingerprint, lessonFingerprint);
  assert.ok(projectExactPreflight.items[0].occurrences >= 50_001,
    'project aggregate must include 100k fixture lesson events plus linked-worktree history');
  assert.ok(projectExactPreflight.items[0].distinctWorkflows >= 2,
    'linked-worktree history must merge by stable ProjectId');

  const globalGroups = await queryOperationalMemoryGroups({ scope: 'global', limit: PAGE_LIMIT });
  const safeGlobal = globalGroups.items.find((item) => item.fingerprint === lessonFingerprint);
  assert.ok(safeGlobal, 'safe whitelisted lesson must appear in Global browsing');
  assert.equal(safeGlobal.kind, 'lesson');
  assert.equal(safeGlobal.reasonCode, 'learned_pattern');
  assert.equal(safeGlobal.lessonCode, 'fetch_required_git_refs');
  assert.equal(safeGlobal.sourceTool, 'project_workflow');
  assert.equal(safeGlobal.family, 'workflow');
  assert.equal(safeGlobal.distinctProjects, 2,
    'linked worktree must count as the same project while unrelated repo counts separately');
  assert.equal(globalGroups.items.some((item) => item.fingerprint === failureFingerprint), false,
    'ordinary failures must never become cross-project Global groups');

  const globalFailureEvents = await queryOperationalMemoryEvents({
    scope: 'global', fingerprint: failureFingerprint, limit: PAGE_LIMIT,
  });
  assert.equal(globalFailureEvents.items.length, 0,
    'ordinary failure drill-down must never cross project boundaries');

  const cappedEvents = await queryOperationalMemoryEvents({
    scope: 'project', projectId, fingerprint: lessonFingerprint, limit: 1000,
  });
  assert.equal(cappedEvents.items.length, 200, 'event page hard cap must be 200 even when limit=1000 is requested');
  const defaultEvents = await queryOperationalMemoryEvents({
    scope: 'project', projectId, fingerprint: lessonFingerprint,
  });
  assert.ok(defaultEvents.items.length <= PAGE_LIMIT, 'default event page must stay at or below 50');

  const firstEventPage = await queryOperationalMemoryEvents({
    scope: 'project', projectId, fingerprint: lessonFingerprint, limit: PAGE_LIMIT,
  });
  assert.equal(firstEventPage.items.length, PAGE_LIMIT);
  assert.ok(firstEventPage.nextCursor, '100k fingerprint drill-down must expose a continuation cursor');
  const secondEventPage = await queryOperationalMemoryEvents({
    scope: 'project', projectId, fingerprint: lessonFingerprint,
    limit: PAGE_LIMIT, cursor: firstEventPage.nextCursor,
  });
  assert.equal(secondEventPage.items.length, PAGE_LIMIT);
  const firstKeys = new Set(firstEventPage.items.map(eventKey));
  assert.equal(secondEventPage.items.some((item) => firstKeys.has(eventKey(item))), false,
    'keyset continuation must not overlap the prior page');
  assert.equal(new Set(secondEventPage.items.map(eventKey)).size, secondEventPage.items.length,
    'keyset continuation must not contain duplicates');

  const forbiddenPaths = [tempDir, primary, linked, other];
  for (const [label, value] of [
    ['overview', preflightOverview],
    ['project exact group', projectExactPreflight],
    ['global groups', globalGroups],
    ['global failure events', globalFailureEvents],
    ['capped events', cappedEvents],
    ['default events', defaultEvents],
    ['first event page', firstEventPage],
    ['second event page', secondEventPage],
  ]) assertPrivacySafe(label, value, forbiddenPaths);

  const metrics = {};
  metrics.overview = await measure('overview', () => getOperationalMemoryOverview());
  metrics.filteredGroups = await measure('filteredGroups', () => queryOperationalMemoryGroups({
    scope: 'project', projectId, kind: 'lesson', limit: PAGE_LIMIT,
  }));
  metrics.fingerprint = await measure('fingerprint', () => queryOperationalMemoryGroups({
    scope: 'project', projectId, fingerprint: lessonFingerprint, limit: PAGE_LIMIT,
  }));
  metrics.drilldown = await measure('drilldown', () => queryOperationalMemoryEvents({
    scope: 'project', projectId, fingerprint: lessonFingerprint, limit: PAGE_LIMIT,
  }));
  metrics.continuation = await measure('continuation', () => queryOperationalMemoryEvents({
    scope: 'project', projectId, fingerprint: lessonFingerprint,
    limit: PAGE_LIMIT, cursor: firstEventPage.nextCursor,
  }));

  assert.ok(metrics.filteredGroups.result.items.length <= PAGE_LIMIT);
  assert.equal(metrics.fingerprint.result.items[0].fingerprint, lessonFingerprint);
  assert.ok(metrics.drilldown.result.items.length <= PAGE_LIMIT);
  assert.ok(metrics.continuation.result.items.length <= PAGE_LIMIT);

  const safeGlobalEvents = await queryOperationalMemoryEvents({
    scope: 'global', fingerprint: lessonFingerprint, limit: PAGE_LIMIT,
  });
  assert.ok(safeGlobalEvents.items.length > 0, 'safe Global group must support sanitized event drill-down');
  assert.ok(safeGlobalEvents.items.every((item) =>
    item.kind === 'lesson' &&
    item.reasonCode === 'learned_pattern' &&
    item.lessonCode === 'fetch_required_git_refs' &&
    item.sourceTool === 'project_workflow' &&
    item.family === 'workflow'
  ), 'Global event drill-down must preserve safe semantic provenance');
  assertPrivacySafe('safe global events', safeGlobalEvents, forbiddenPaths);

  assert.equal(typeof global.gc, 'function', 'run M6 scale gate with node --expose-gc');
  global.gc();
  const heapBefore = process.memoryUsage().heapUsed;
  for (let index = 0; index < 20; index += 1) {
    await getOperationalMemoryOverview();
    await queryOperationalMemoryGroups({ scope: 'project', projectId, kind: 'lesson', limit: PAGE_LIMIT });
    await queryOperationalMemoryGroups({ scope: 'project', projectId, fingerprint: lessonFingerprint, limit: PAGE_LIMIT });
    await queryOperationalMemoryEvents({ scope: 'project', projectId, fingerprint: lessonFingerprint, limit: PAGE_LIMIT });
  }
  global.gc();
  const heapAfter = process.memoryUsage().heapUsed;
  const heapGrowthBytes = Math.max(0, heapAfter - heapBefore);
  console.log(JSON.stringify({ metric: 'm6_scale', operation: 'heapGrowth',
    heapGrowthBytes, heapGrowthMiB: Number((heapGrowthBytes / 1024 / 1024).toFixed(3)) }));

  const afterReads = await snapshotMemoryFiles(stateRoot);
  assertSnapshotsEqual(afterReads, beforeReads);

  const performanceFailures = [];
  if (metrics.overview.p95Ms >= SMALL_PAGE_P95_MS) performanceFailures.push(`overview p95 ${metrics.overview.p95Ms.toFixed(3)}ms`);
  if (metrics.filteredGroups.p95Ms >= HOT_FILTER_P95_MS) performanceFailures.push(`filteredGroups p95 ${metrics.filteredGroups.p95Ms.toFixed(3)}ms`);
  if (metrics.fingerprint.p95Ms >= HOT_FILTER_P95_MS) performanceFailures.push(`fingerprint p95 ${metrics.fingerprint.p95Ms.toFixed(3)}ms`);
  if (metrics.drilldown.p95Ms >= SMALL_PAGE_P95_MS) performanceFailures.push(`drilldown p95 ${metrics.drilldown.p95Ms.toFixed(3)}ms`);
  if (metrics.continuation.p95Ms >= SMALL_PAGE_P95_MS) performanceFailures.push(`continuation p95 ${metrics.continuation.p95Ms.toFixed(3)}ms`);
  if (heapGrowthBytes >= MAX_HEAP_GROWTH) performanceFailures.push(`heap growth ${(heapGrowthBytes / 1024 / 1024).toFixed(3)}MiB`);

  if (performanceFailures.length > 0) {
    printQueryPlans(primaryIndexPath, lessonFingerprint);
    assert.fail(`M6 100k scale thresholds failed: ${performanceFailures.join('; ')}`);
  }

  console.log(JSON.stringify({ metric: 'm6_scale', operation: 'fixture',
    primaryEvents, totalOverviewEvents: preflightOverview.totalEvents,
    projectId, linkedProjectId: linkedStart.projectIdentity.projectId,
    globalDistinctProjects: safeGlobal.distinctProjects }));
  console.log('PASS M6 Operational Memory Control Center 100k scale/privacy gate');
} finally {
  if (previousStateRoot === undefined) delete process.env.DESKTOP_COMMANDER_WORKFLOW_STATE_DIR;
  else process.env.DESKTOP_COMMANDER_WORKFLOW_STATE_DIR = previousStateRoot;
  await fs.rm(tempDir, { recursive: true, force: true });
}
