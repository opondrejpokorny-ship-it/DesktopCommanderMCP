/** RED -> GREEN interaction proof for the lazy M6 Memory Control Center view. */
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { JSDOM } from 'jsdom';
import { startControlCenter } from '../dist/control-center/server.js';

let DatabaseSync;
try { ({ DatabaseSync } = await import('node:sqlite')); }
catch { console.log('SKIP M6 Memory UI: node:sqlite unavailable'); process.exit(0); }

const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'dc-memory-m6-ui-'));
const stateRoot = path.join(tempDir, 'state');
const policyFile = path.join(tempDir, 'policy.json');
const auditFile = path.join(tempDir, 'audit.jsonl');
const envKeys = [
  'DESKTOP_COMMANDER_WORKFLOW_STATE_DIR',
  'DESKTOP_COMMANDER_POLICY_FILE',
  'DESKTOP_COMMANDER_AUDIT_FILE',
];
const oldEnv = Object.fromEntries(envKeys.map((key) => [key, process.env[key]]));
process.env.DESKTOP_COMMANDER_WORKFLOW_STATE_DIR = stateRoot;
process.env.DESKTOP_COMMANDER_POLICY_FILE = policyFile;
process.env.DESKTOP_COMMANDER_AUDIT_FILE = auditFile;

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

async function seedMemory() {
  await fs.mkdir(stateRoot, { recursive: true });
  const id = '121212121212121212121212';
  const journalPath = path.join(stateRoot, `${id}.memory.jsonl`);
  const indexPath = path.join(stateRoot, `${id}.memory.sqlite`);
  await fs.writeFile(journalPath, '{"fixture":"PRIVATE_FILE_CONTENT PRIVATE_COMMAND"}\n', 'utf8');
  const stat = await fs.stat(journalPath);
  const db = new DatabaseSync(indexPath);
  createSchema(db);
  const insertEvent = db.prepare(`
    INSERT INTO events (
      record_sequence, start_offset, end_offset, workflow_id, task_id, run_id,
      kind, reason_code, lesson_code, source_tool, family, stage_id, fingerprint, occurred_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, ?, ?, ?, ?)
  `);
  const insertGroup = db.prepare(`
    INSERT INTO groups (
      workflow_id, fingerprint, kind, reason_code, lesson_code, source_tool, family,
      stage_id, first_seen_at, last_seen_at, occurrences, latest_record_sequence
    ) VALUES (?, ?, ?, ?, NULL, ?, ?, ?, ?, ?, 1, ?)
  `);
  const insertProject = db.prepare(`
    INSERT INTO project_groups (
      fingerprint, kind, reason_code, lesson_code, source_tool, family, stage_id,
      first_seen_at, last_seen_at, occurrences, distinct_workflows,
      latest_workflow_id, latest_record_sequence
    ) VALUES (?, ?, ?, NULL, ?, ?, ?, ?, ?, 1, 1, ?, ?)
  `);
  const base = Date.parse('2026-09-05T12:00:00.000Z');
  for (let index = 0; index < 51; index += 1) {
    const sequence = index + 1;
    const workflowId = `workflow-ui-${String(index).padStart(3, '0')}`;
    const fingerprint = `fp-ui-${String(index).padStart(3, '0')}`;
    const occurredAt = new Date(base + index * 1000).toISOString();
    insertEvent.run(
      sequence, sequence * 10, sequence * 10 + 5, workflowId,
      `task-${index}`, `run-${index}`, 'error', 'not_found', 'read_file',
      'filesystem', 'inspect', fingerprint, occurredAt,
    );
    insertGroup.run(
      workflowId, fingerprint, 'error', 'not_found', 'read_file', 'filesystem',
      'inspect', occurredAt, occurredAt, sequence,
    );
    insertProject.run(
      fingerprint, 'error', 'not_found', 'read_file', 'filesystem', 'inspect',
      occurredAt, occurredAt, workflowId, sequence,
    );
  }
  db.prepare(`
    INSERT INTO index_state (
      id, schema_version, indexed_through_offset, authority_size_bytes,
      authority_mtime_ms, authority_ctime_ms, record_count, project_id,
      repository_id, authority_chain_hash, rebuild_status
    ) VALUES (1, 5, ?, ?, ?, ?, 51, 'project-ui', 'repo-ui', 'fixture-chain', 'ready')
  `).run(stat.size, stat.size, stat.mtimeMs, stat.ctimeMs);
  db.close();
}

async function waitFor(predicate, label, timeoutMs = 4000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error(`Timed out waiting for ${label}`);
}

let controlCenter;
let dom;
const memoryCalls = [];
const clipboardWrites = [];
let paginationGate;
let releasePagination;
let paginationCompletions = 0;
let filterRefreshGate;
let releaseFilterRefresh;
let delayedEventFingerprint;
let delayedEventGate;
let releaseDelayedEvent;
let delayedEventCompletions = 0;
try {
  await seedMemory();
  await fs.writeFile(policyFile, JSON.stringify({
    version: 1,
    tier: 'free',
    profile: 'safe_developer',
    rules: [],
  }), 'utf8');
  controlCenter = await startControlCenter({
    host: '127.0.0.1', port: 0, token: 'memory-ui-test-token', quiet: true,
  });

  const homeResponse = await fetch(controlCenter.url);
  assert.equal(homeResponse.status, 200);
  const html = await homeResponse.text();
  assert.match(html, />Memory</);
  assert.match(html, /id="memory-overview"/);
  assert.match(html, /id="memory-groups"/);
  assert.doesNotMatch(html, /PRIVATE_FILE_CONTENT|PRIVATE_COMMAND/);

  dom = new JSDOM(html, {
    url: controlCenter.url,
    runScripts: 'dangerously',
    pretendToBeVisual: true,
    beforeParse(window) {
      window.Headers = Headers;
      window.Request = Request;
      window.Response = Response;
      window.fetch = async (input, init) => {
        const raw = typeof input === 'string' ? input : input.url;
        const target = new URL(raw, controlCenter.url);
        if (target.pathname.startsWith('/api/memory/')) memoryCalls.push(target.href);
        const isContinuation = target.pathname === '/api/memory/groups' && target.searchParams.has('cursor');
        const isDelayedEvent = delayedEventFingerprint &&
          target.pathname === `/api/memory/groups/${encodeURIComponent(delayedEventFingerprint)}/events`;
        const isDelayedFilterRefresh = target.pathname === '/api/memory/groups' &&
          target.searchParams.get('kind') === 'lesson' && !target.searchParams.has('cursor');
        if (isContinuation && paginationGate) await paginationGate;
        if (isDelayedFilterRefresh && filterRefreshGate) await filterRefreshGate;
        if (isDelayedEvent && delayedEventGate) await delayedEventGate;
        const response = await fetch(target, init);
        if (isContinuation) paginationCompletions += 1;
        if (isDelayedEvent) delayedEventCompletions += 1;
        return response;
      };
      Object.defineProperty(window.navigator, 'clipboard', {
        configurable: true,
        value: { writeText: async (value) => { clipboardWrites.push(String(value)); } },
      });
    },
  });

  await waitFor(
    () => dom.window.document.getElementById('dc-entitlement')?.textContent !== 'Loading…',
    'initial Control Center state',
  );
  assert.equal(memoryCalls.length, 0, 'Memory APIs must not be called before Memory activation');

  const memoryButton = dom.window.document.querySelector('[data-dc-target="memory"]');
  assert.ok(memoryButton, 'Memory navigation button should exist');
  memoryButton.click();
  await waitFor(
    () => memoryCalls.some((url) => new URL(url).pathname === '/api/memory/overview'),
    'Memory overview request',
  );
  await waitFor(
    () => dom.window.document.querySelectorAll('[data-memory-group]').length === 50,
    'first Memory group page',
  );

  assert.equal(
    dom.window.document.querySelector('[data-memory-metric="total-events"]')?.textContent,
    '51',
  );
  assert.match(dom.window.document.getElementById('memory-groups')?.textContent ?? '', /fp-ui-050/);
  assert.ok(!dom.window.document.body.textContent.includes('PRIVATE_FILE_CONTENT'));
  assert.ok(!dom.window.document.body.textContent.includes('PRIVATE_COMMAND'));

  const kindFilter = dom.window.document.getElementById('memory-filter-kind');
  assert.ok(kindFilter);
  filterRefreshGate = new Promise((resolve) => { releaseFilterRefresh = resolve; });
  const continuationCallsBeforeFilter = memoryCalls.filter(
    (url) => new URL(url).pathname === '/api/memory/groups' && new URL(url).searchParams.has('cursor'),
  ).length;
  kindFilter.value = 'lesson';
  kindFilter.dispatchEvent(new dom.window.Event('change', { bubbles: true }));
  await waitFor(
    () => memoryCalls.some((url) => {
      const target = new URL(url);
      return target.pathname === '/api/memory/groups' && target.searchParams.get('kind') === 'lesson' && !target.searchParams.has('cursor');
    }),
    'server-side Memory kind filter',
  );
  const loadMoreDuringFilter = dom.window.document.getElementById('memory-load-more');
  assert.ok(loadMoreDuringFilter);
  assert.equal(loadMoreDuringFilter.hidden, true, 'filter refresh must hide stale pagination immediately');
  paginationGate = new Promise((resolve) => { releasePagination = resolve; });
  loadMoreDuringFilter.click();
  await new Promise((resolve) => setTimeout(resolve, 60));
  const continuationCallsAfterFilterClick = memoryCalls.filter(
    (url) => new URL(url).pathname === '/api/memory/groups' && new URL(url).searchParams.has('cursor'),
  ).length;
  releasePagination();
  releaseFilterRefresh();
  await new Promise((resolve) => setTimeout(resolve, 120));
  paginationGate = undefined;
  releasePagination = undefined;
  filterRefreshGate = undefined;
  releaseFilterRefresh = undefined;
  assert.equal(
    continuationCallsAfterFilterClick, continuationCallsBeforeFilter,
    'filter refresh must invalidate the previous cursor before its response completes',
  );
  await waitFor(
    () => dom.window.document.querySelectorAll('[data-memory-group]').length === 0,
    'filtered empty group set',
  );
  kindFilter.value = 'error';
  kindFilter.dispatchEvent(new dom.window.Event('change', { bubbles: true }));
  await waitFor(
    () => dom.window.document.querySelectorAll('[data-memory-group]').length === 50,
    'restored error group page',
  );

  const initialRows = [...dom.window.document.querySelectorAll('[data-memory-group]')];
  assert.match(initialRows[0]?.textContent ?? '', /fp-ui-050/);
  assert.match(initialRows[1]?.textContent ?? '', /fp-ui-049/);
  const openButtons = [...dom.window.document.querySelectorAll('[data-memory-open]')];
  assert.ok(openButtons.length >= 2);
  delayedEventFingerprint = 'fp-ui-050';
  delayedEventGate = new Promise((resolve) => { releaseDelayedEvent = resolve; });
  openButtons[0].click();
  await waitFor(
    () => memoryCalls.some((url) => new URL(url).pathname.endsWith('/fp-ui-050/events')),
    'delayed first Memory drill-down request',
  );
  openButtons[1].click();
  await waitFor(
    () => (dom.window.document.getElementById('memory-events')?.textContent ?? '').includes('fp-ui-049'),
    'newer Memory drill-down rendering',
  );
  releaseDelayedEvent();
  await waitFor(() => delayedEventCompletions === 1, 'delayed Memory drill-down completion');
  const racedEventText = dom.window.document.getElementById('memory-events')?.textContent ?? '';
  assert.match(racedEventText, /fp-ui-049/);
  assert.doesNotMatch(racedEventText, /fp-ui-050/);
  assert.match(racedEventText, /read_file/);
  assert.match(racedEventText, /not_found/);
  assert.doesNotMatch(racedEventText, /PRIVATE_FILE_CONTENT|PRIVATE_COMMAND/);
  delayedEventFingerprint = undefined;
  delayedEventGate = undefined;
  releaseDelayedEvent = undefined;

  const loadMore = dom.window.document.getElementById('memory-load-more');
  assert.ok(loadMore && !loadMore.hidden, 'Load more should expose returned keyset cursor');
  const continuationCount = (predicate = () => true) => memoryCalls.filter((url) => {
    const target = new URL(url);
    return target.pathname === '/api/memory/groups' && target.searchParams.has('cursor') && predicate(target);
  }).length;

  const continuationCallsBefore = continuationCount();
  paginationGate = new Promise((resolve) => { releasePagination = resolve; });
  const releaseOldPagination = releasePagination;
  loadMore.click();
  await waitFor(() => continuationCount() === continuationCallsBefore + 1, 'first in-flight continuation request');
  paginationGate = undefined;
  releasePagination = undefined;

  const sourceFilter = dom.window.document.getElementById('memory-filter-source');
  assert.ok(sourceFilter && [...sourceFilter.options].some((option) => option.value === 'read_file'));
  sourceFilter.value = 'read_file';
  sourceFilter.dispatchEvent(new dom.window.Event('change', { bubbles: true }));
  await waitFor(
    () => memoryCalls.some((url) => {
      const target = new URL(url);
      return target.pathname === '/api/memory/groups' && target.searchParams.get('sourceTool') === 'read_file' && !target.searchParams.has('cursor');
    }),
    'same-result filter refresh',
  );
  await waitFor(() => !loadMore.hidden, 'replacement cursor after same-result filter refresh');

  paginationGate = new Promise((resolve) => { releasePagination = resolve; });
  const releaseNewPagination = releasePagination;
  const filteredContinuationBefore = continuationCount((target) => target.searchParams.get('sourceTool') === 'read_file');
  loadMore.click();
  loadMore.click();
  await waitFor(
    () => continuationCount((target) => target.searchParams.get('sourceTool') === 'read_file') === filteredContinuationBefore + 1,
    'single new-generation continuation request',
  );
  const completionsBeforeOldRelease = paginationCompletions;
  releaseOldPagination();
  await waitFor(() => paginationCompletions === completionsBeforeOldRelease + 1, 'old-generation continuation completion');
  loadMore.click();
  await new Promise((resolve) => setTimeout(resolve, 60));
  assert.equal(
    continuationCount((target) => target.searchParams.get('sourceTool') === 'read_file'),
    filteredContinuationBefore + 1,
    'old-generation completion must not release the active new-generation cursor guard',
  );
  releaseNewPagination();
  await waitFor(() => dom.window.document.querySelectorAll('[data-memory-group]').length === 51, 'new-generation continuation completion');
  paginationGate = undefined;
  releasePagination = undefined;
  const pagedRows = [...dom.window.document.querySelectorAll('[data-memory-group]')];
  assert.equal(pagedRows.length, 51, 'serialized pagination must append exactly one continuation page');
  const pagedFingerprints = new Set(
    pagedRows.map((row) => row.textContent.match(/fp-ui-\d{3}/)?.[0]).filter(Boolean),
  );
  assert.equal(pagedFingerprints.size, 51, 'Memory pagination must not create duplicate fingerprints');

  const firstCopy = dom.window.document.querySelector('[data-memory-copy]');
  assert.ok(firstCopy);
  firstCopy.click();
  await waitFor(() => clipboardWrites.length === 1, 'fingerprint copy');
  assert.match(clipboardWrites[0], /^fp-ui-/);

  assert.doesNotMatch(
    dom.window.document.body.textContent,
    /Repair memory|Delete lesson|Promote lesson|Ignore lesson/i,
  );
  let raceDom;
  let releaseInitialGroup;
  const initialGroupGate = new Promise((resolve) => { releaseInitialGroup = resolve; });
  let blockedInitialGroup = false;
  let initialGroupFinished = false;
  const raceCalls = [];
  try {
    raceDom = new JSDOM(html, {
      url: controlCenter.url,
      runScripts: 'dangerously',
      pretendToBeVisual: true,
      beforeParse(window) {
        window.Headers = Headers;
        window.Request = Request;
        window.Response = Response;
        window.fetch = async (input, init) => {
          const raw = typeof input === 'string' ? input : input.url;
          const target = new URL(raw, controlCenter.url);
          if (target.pathname.startsWith('/api/memory/')) raceCalls.push(target.href);
          const isInitialGroup = target.pathname === '/api/memory/groups' &&
            !target.searchParams.has('cursor') && !target.searchParams.has('kind') && !blockedInitialGroup;
          if (isInitialGroup) {
            blockedInitialGroup = true;
            await initialGroupGate;
          }
          const response = await fetch(target, init);
          if (isInitialGroup) initialGroupFinished = true;
          return response;
        };
      },
    });
    await waitFor(
      () => raceDom.window.document.getElementById('dc-entitlement')?.textContent !== 'Loadingâ€¦',
      'race Control Center state',
    );
    const raceMemoryButton = raceDom.window.document.querySelector('[data-dc-target="memory"]');
    assert.ok(raceMemoryButton);
    raceMemoryButton.click();
    await waitFor(() => blockedInitialGroup, 'blocked initial Memory group request');
    const raceKindFilter = raceDom.window.document.getElementById('memory-filter-kind');
    assert.ok(raceKindFilter);
    raceKindFilter.value = 'lesson';
    raceKindFilter.dispatchEvent(new raceDom.window.Event('change', { bubbles: true }));
    await waitFor(
      () => raceCalls.some((url) => new URL(url).pathname === '/api/memory/groups' && new URL(url).searchParams.get('kind') === 'lesson'),
      'replacement initial-load filter request',
      800,
    );
    releaseInitialGroup();
    releaseInitialGroup = undefined;
    await waitFor(() => initialGroupFinished, 'stale initial Memory group response');
    await waitFor(
      () => raceDom.window.document.querySelectorAll('[data-memory-group]').length === 0,
      'replacement initial-load filter result',
    );
    assert.equal(raceDom.window.document.getElementById('memory-load-more')?.hidden, true);
  } finally {
    releaseInitialGroup?.();
    raceDom?.window.close();
  }

  console.log('✅ Operational Memory Control Center lazy UI tests passed');
} finally {
  dom?.window.close();
  if (controlCenter) await controlCenter.close();
  for (const key of envKeys) {
    if (oldEnv[key] === undefined) delete process.env[key];
    else process.env[key] = oldEnv[key];
  }
  await fs.rm(tempDir, { recursive: true, force: true });
}
