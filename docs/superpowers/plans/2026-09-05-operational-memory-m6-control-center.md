# Operational Memory M6 Control Center Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a read-only Operational Memory view to the local Control Center so a human can inspect, filter, paginate, and drill into privacy-safe memory across 100k+ events without opening JSONL manually.

**Architecture:** Add a dedicated `src/workflow/operational-memory-query.ts` read model that discovers only server-owned workflow-state memory files and opens existing SQLite indexes read-only. The Control Center exposes bounded `/api/memory/*` GET routes and lazy-loads a Memory view; normal `/api/state` polling remains unchanged. M6 never repairs/rebuilds indexes and never changes policy, approval, entitlement, Active Work, or MCP authorization semantics.

**Tech Stack:** TypeScript, Node.js built-in `node:sqlite` `DatabaseSync`, Node HTTP server, inline Control Center HTML/CSS/JS, Node assert-based integration tests.

**Spec:** `docs/superpowers/specs/2026-09-05-operational-memory-m6-control-center-design.md`

## Global Constraints

- Before execution, fresh-read Drive bootstrap docs and Active Work Registry, fetch all remotes, and verify the authoritative `prototype/free-pro-team` SHA.
- Do not execute runtime Tasks 1-7 while M3B owns Operational Memory persistence/retrieval unless M3B has integrated or overlap is explicitly coordinated.
- Create the implementation branch/worktree from the then-current authoritative prototype using `superpowers:using-git-worktrees`; do not implement in this docs worktree.
- JSONL remains durable authority; SQLite remains derived/disposable/rebuildable.
- All M6 SQLite opens are read-only; M6 must not call `ensureOperationalMemoryIndex()` or any repair/rebuild/synchronization helper.
- No browser-supplied filesystem path is accepted for memory discovery.
- Every `/api/memory/*` request requires the existing Control Center session token.
- No raw MCP args/results, terminal commands/output, file contents, credentials, approval payloads, raw JSONL, SQL text, or filesystem paths may reach the Memory API response.
- Default page size is 50; hard maximum is 200.
- No Memory mutation endpoint and no model-facing broad Memory browsing/editing MCP tool.
- No deployment without explicit authorization.

---
## File Structure

- Create `src/workflow/operational-memory-query.ts`: read-only discovery, health classification, overview, groups, events, filters, cursor encoding/decoding, and server-controlled presentation text.
- Modify `src/control-center/server.ts`: strict query parsing, four authenticated Memory GET routes, lazy Memory UI, and generic sanitized 400/500 behavior.
- Create `test/test-operational-memory-control-center-query.js`: focused read-model RED→GREEN coverage for health, grouping, filtering, pagination, global safety, and privacy.
- Modify `test/test-tier-control-center.js`: authenticated/unauthenticated Memory API and rendered-UI contract checks while preserving existing policy/approval coverage.
- Create `test/test-operational-memory-control-center-ui.js`: JSDOM interaction smoke for lazy Memory activation, server-backed filtering/pagination, and sanitized drill-down rendering.
- Create `test/test-operational-memory-control-center-scale.js`: 100k-event indexed navigation, bounded response, and non-mutation proof.
- Reuse `test/benchmarks/operational-memory-scale-benchmark.js` for comparative measurements; do not fold M6 acceptance assertions into the historical M0 benchmark.
- Modify Operational Memory source outside the new query module only if the integrated M3B implementation requires a tiny pure export to expose its safe-global semantic reader. Do not change persistence semantics or SQLite schema for M6 unless measured 100k queries prove the existing schema inadequate.

### Task 1: Read-only discovery, health, and overview

**Files:**
- Create: `src/workflow/operational-memory-query.ts`
- Create: `test/test-operational-memory-control-center-query.js`

**Interfaces:**
- Consumes: `resolveWorkflowStateRoot()` from `src/workflow/workflow-storage.ts`; built-in `node:sqlite`; existing `*.memory.jsonl` and `*.memory.sqlite` schema version after M3B integration.
- Produces: `getOperationalMemoryOverview(): Promise<MemoryOverviewResponse>` and shared read-model types used by later tasks.
- [ ] **Step 1: Write the failing overview/health test**

Create fixtures under a temp `DESKTOP_COMMANDER_WORKFLOW_STATE_DIR`: one healthy indexed project, one second journal/index with the same ProjectId to prove deduplication, one stale index, one missing index, one corrupt index, and one orphaned index. Capture all journal/index bytes and mtimes before the M6 call.

```js
const overview = await memoryQuery.getOperationalMemoryOverview();
assert.equal(overview.projectsWithMemory, 1);
assert.equal(overview.indexHealth.stale, 1);
assert.equal(overview.indexHealth.missing, 1);
assert.equal(overview.indexHealth.corrupt, 1);
assert.equal(overview.indexHealth.orphaned, 1);
assert.ok(overview.totalEvents > 0);
assert.ok(overview.journalBytes > 0);
assert.ok(overview.lastActivityAt);
```

- [ ] **Step 2: Run the focused test and verify RED**

Run: `npm run build && node test/test-operational-memory-control-center-query.js`

Expected: FAIL because `dist/workflow/operational-memory-query.js` / `getOperationalMemoryOverview()` does not exist.

- [ ] **Step 3: Implement the typed read-only discovery foundation**

Use these public types in `operational-memory-query.ts`:

```ts
export type MemoryIndexHealth = 'healthy' | 'stale' | 'missing' | 'corrupt' | 'orphaned' | 'unavailable';
export type MemoryBrowseScope = 'workflow' | 'project' | 'global';
export interface MemoryIndexHealthCounts { healthy: number; stale: number; missing: number; corrupt: number; orphaned: number; }
```
```ts
export interface MemoryOverviewResponse {
  generatedAt: string;
  totalEvents: number;
  uniqueFingerprints: number;
  projectsWithMemory: number;
  countsByKind: { error: number; limit: number; lesson: number };
  journalBytes: number;
  indexBytes: number;
  lastActivityAt?: string;
  indexHealth: { overall: 'healthy' | 'degraded' | 'unavailable' } & MemoryIndexHealthCounts;
}
export async function getOperationalMemoryOverview(): Promise<MemoryOverviewResponse>;
```

Discovery algorithm:
1. `readdir(resolveWorkflowStateRoot())` once and union basenames ending in `.memory.jsonl` or `.memory.sqlite`.
2. For each basename, `stat` only those server-derived paths.
3. Open an existing index with `new DatabaseSync(indexPath, { readOnly: true })`; never call index ensure/rebuild code.
4. Validate required tables/columns and read the single `index_state` row.
5. Classify `missing`, `orphaned`, `corrupt`, or `stale` from journal/index existence plus `authority_size_bytes`, `authority_mtime_ms`, `authority_ctime_ms`, and schema compatibility.
6. For healthy indexes only, read aggregate counts from SQLite and deduplicate `projectsWithMemory` by `project_id`.
7. If `node:sqlite` is unavailable, return `overall: 'unavailable'` with zero query-derived counts and filesystem size metadata; never fall back to JSONL scanning.

- [ ] **Step 4: Run the focused test and verify GREEN**

Run: `npm run build && node test/test-operational-memory-control-center-query.js`

Expected: PASS for overview/health cases, including byte/mtime equality before and after the call.

- [ ] **Step 5: Commit Task 1**

```bash
git add src/workflow/operational-memory-query.ts test/test-operational-memory-control-center-query.js
git commit -m "feat: add read-only operational memory overview"
```
### Task 2: Group browsing, filters, keyset pagination, and safe Global semantics

**Files:**
- Modify: `src/workflow/operational-memory-query.ts`
- Modify: `test/test-operational-memory-control-center-query.js`
- Modify only if needed after M3B integration: `src/workflow/operational-memory.ts` or the exact M3B helper module, limited to exporting an already-existing pure safe-global reader without changing its ranking/whitelist behavior.

**Interfaces:**
- Consumes: healthy index descriptors from Task 1 and the integrated M3B safe-global semantic rule.
- Produces: `queryOperationalMemoryGroups(query: MemoryGroupQuery): Promise<MemoryGroupPage>` and `getOperationalMemoryFilterOptions(): Promise<MemoryFilterOptions>`.

```ts
export interface MemoryGroupQuery {
  projectId?: string;
  scope?: MemoryBrowseScope;
  kind?: 'error' | 'limit' | 'lesson';
  reasonCode?: string;
  lessonCode?: string;
  sourceTool?: string;
  family?: string;
  stageId?: string;
  from?: string;
  to?: string;
  fingerprint?: string;
  minOccurrences?: number;
  limit?: number;
  cursor?: string;
}
export interface MemoryGroupItem {
  projectId?: string;
  repositoryId?: string;
  projectDisplayName?: string;
  scope: MemoryBrowseScope;
  fingerprint: string;
  kind: 'error' | 'limit' | 'lesson';
  reasonCode: string;
  lessonCode?: string;
  sourceTool: string;
  family: string;
  stageId?: string;
  title: string;
  lesson: string;
  occurrences: number;
  distinctWorkflows?: number;
  distinctProjects?: number;
  firstSeenAt: string;
  lastSeenAt: string;
  relevanceExplanation: string;
}
export interface MemoryFilterOptions {
  projects: Array<{ projectId: string; displayName: string }>;
  kinds: Array<'error' | 'limit' | 'lesson'>;
  reasonCodes: string[];
  lessonCodes: string[];
  sourceTools: string[];
  families: string[];
  stageIds: string[];
  truncated: {
    projects: boolean;
    reasonCodes: boolean;
    lessonCodes: boolean;
    sourceTools: boolean;
    families: boolean;
    stageIds: boolean;
  };
}
export interface MemoryGroupPage { items: MemoryGroupItem[]; nextCursor?: string; health: MemoryOverviewResponse['indexHealth']; }
export async function queryOperationalMemoryGroups(query: MemoryGroupQuery): Promise<MemoryGroupPage>;
export async function getOperationalMemoryFilterOptions(): Promise<MemoryFilterOptions>;
```

`projectId` is present for workflow/project items. A Global item is cross-project by definition, so it omits `projectId` and reports `distinctProjects`; the UI labels its project field `Global`. This is presentation metadata only and never becomes a synthetic ProjectId or authorization identity.

- [ ] **Step 1: Extend the focused test with project/workflow/global group REDs**

Seed two workflows for one stable ProjectId plus an unrelated project. Assert exact fingerprint lookup, every roadmap filter, `minOccurrences`, project dedupe, deterministic ordering, page size 50/default and 200/max, cursor continuation without duplicates, and malformed cursor rejection at the HTTP layer later.

For Global scope, assert only `reason_code='learned_pattern'` rows whose `lesson_code` passes the integrated M3B server whitelist are eligible. Explicitly seed an ordinary `not_found` failure and an invalid learned-pattern row and assert neither appears globally.

```js
const page = await memoryQuery.queryOperationalMemoryGroups({
  scope: 'project', projectId, fingerprint: expectedFingerprint, limit: 1,
});
assert.equal(page.items.length, 1);
assert.equal(page.items[0].projectId, projectId);
assert.equal(page.items[0].scope, 'project');
assert.ok(page.items[0].occurrences >= 2);
assert.ok(!JSON.stringify(page).includes('PRIVATE_INVALID_LESSON_CODE'));
```

- [ ] **Step 2: Run the group test and verify RED**

Run: `npm run build && node test/test-operational-memory-control-center-query.js`

Expected: FAIL because group/filter/cursor functions are missing.

- [ ] **Step 3: Implement project and workflow aggregate reads**

Use bound parameters for all text filters. Query only aggregate tables for group browsing: `project_groups` for project scope and `groups` for workflow scope. Merge same-project linked-worktree rows by `projectId + fingerprint`; sum occurrences/distinct workflows, keep minimum `firstSeenAt`, and take display metadata from the row with maximum `lastSeenAt`.
Group ordering and cursor contract:

```ts
const sortKey = [item.lastSeenAt, item.projectId, item.fingerprint, item.scope] as const;
// Descending lastSeenAt; ascending projectId/fingerprint/scope for ties.
// Cursor payload contains only these four values, base64url-encoded JSON, then revalidated on decode.
```

Apply `from`/`to` to `last_seen_at` for group browsing. Apply `minOccurrences` only after same-project worktree rows have been merged so split history cannot be incorrectly excluded.

Server-controlled display text must be reconstructed from `reasonCode` / valid `lessonCode`. For `learned_pattern`, use `OPERATIONAL_LESSON_TEMPLATES`. For generic reason codes, use a closed switch matching the current Operational Memory wording; do not return persisted `summary`/`lesson` strings because they are not stored in SQLite and must never be recovered from JSONL for M6.

- [ ] **Step 4: Implement Global group browsing by reusing M3B semantics**

After M3B integration, inspect its final safe-global implementation. Reuse or extract a pure read-only helper with this contract:

```ts
interface SafeGlobalGroupSource {
  projectId: string;
  repositoryId?: string;
  fingerprint: string;
  lessonCode: OperationalLessonCode;
  sourceTool: string;
  family: string;
  stageId?: string;
  firstSeenAt: string;
  lastSeenAt: string;
  occurrences: number;
  distinctProjects: number;
}
```

The helper must accept already-discovered healthy read-only index descriptors, include only server-whitelisted `OperationalLessonCode` rows, dedupe linked worktrees by ProjectId before computing `distinctProjects`, and never open a foreign candidate read-write. M6 must not create a second whitelist.

- [ ] **Step 5: Implement bounded filter options**

Return only sanitized values already present in aggregate/index-state columns: ProjectIds with safe display fallback, three kinds, validated reason/lesson codes, safe tool names, families, and stage IDs. Sort values lexicographically and deduplicate in the query module. Bound output with `MAX_PROJECT_OPTIONS = 1000` and `MAX_FILTER_OPTIONS_PER_FIELD = 500`; return `truncated: true` per affected dimension so the UI can prefer typed fingerprint/code filters when a dropdown is incomplete. These caps bound response/memory use without changing query eligibility.
- [ ] **Step 6: Run group/filter tests and verify GREEN**

Run: `npm run build && node test/test-operational-memory-control-center-query.js`

Expected: PASS for project/workflow/global grouping, all filters, deterministic cursor pagination, linked-worktree dedupe, and Global whitelist negatives.

- [ ] **Step 7: Commit Task 2**

```bash
git add src/workflow/operational-memory-query.ts test/test-operational-memory-control-center-query.js
git add src/workflow/operational-memory.ts  # only when the final M3B implementation required the pure helper export
git commit -m "feat: add operational memory group browsing"
```

### Task 3: Sanitized event drill-down and non-mutation proof

**Files:**
- Modify: `src/workflow/operational-memory-query.ts`
- Modify: `test/test-operational-memory-control-center-query.js`

**Interfaces:**
- Consumes: Task 1 healthy index discovery and Task 2 validated cursors.
- Produces: `queryOperationalMemoryEvents(query: MemoryEventQuery): Promise<MemoryEventPage>`.

```ts
export interface MemoryEventQuery {
  fingerprint: string;
  projectId?: string;
  scope: MemoryBrowseScope;
  from?: string;
  to?: string;
  limit?: number;
  cursor?: string;
}
export interface MemoryEventItem {
  projectId?: string;
  repositoryId?: string;
  workflowId: string;
  taskId?: string;
  runId?: string;
  kind: 'error' | 'limit' | 'lesson';
  reasonCode: string;
  lessonCode?: string;
  sourceTool: string;
  family: string;
  stageId?: string;
  fingerprint: string;
  occurredAt: string;
}
export interface MemoryEventPage {
  items: MemoryEventItem[];
  nextCursor?: string;
  health: MemoryOverviewResponse['indexHealth'];
}
export async function queryOperationalMemoryEvents(query: MemoryEventQuery): Promise<MemoryEventPage>;
```
- [ ] **Step 1: Add failing drill-down privacy tests**

Seed valid events plus fake prohibited markers in nearby journal prose / invalid rows: `FAKE_API_KEY_SECRET`, `rm -rf PRIVATE_COMMAND`, `PRIVATE_FILE_CONTENT`, `PRIVATE_MCP_ARGS`, and `PRIVATE_APPROVAL_PAYLOAD`. Build the derived index through existing runtime setup before capturing bytes/mtimes. Define the snapshot helper in the test so the non-mutation assertion compares both bytes and filesystem metadata for every `*.memory.jsonl` / `*.memory.sqlite` file:

```js
async function snapshotMemoryFiles(root) {
  const names = (await fs.readdir(root)).filter((name) => /\.memory\.(jsonl|sqlite)$/.test(name)).sort();
  return Promise.all(names.map(async (name) => {
    const filePath = path.join(root, name);
    const [bytes, stat] = await Promise.all([fs.readFile(filePath), fs.stat(filePath)]);
    return { name, bytes: bytes.toString('base64'), size: stat.size, mtimeMs: stat.mtimeMs };
  }));
}
const forbiddenMarkers = [
  'FAKE_API_KEY_SECRET', 'rm -rf PRIVATE_COMMAND', 'PRIVATE_FILE_CONTENT',
  'PRIVATE_MCP_ARGS', 'PRIVATE_APPROVAL_PAYLOAD',
];
const before = await snapshotMemoryFiles(stateRoot);
const events = await memoryQuery.queryOperationalMemoryEvents({
  scope: 'project', projectId, fingerprint, limit: 50,
});
const serialized = JSON.stringify(events);
for (const marker of forbiddenMarkers) assert.equal(serialized.includes(marker), false);
const after = await snapshotMemoryFiles(stateRoot);
assert.deepEqual(after, before, 'M6 read path must not mutate journal/index state');
```

- [ ] **Step 2: Run the focused test and verify RED**

Run: `npm run build && node test/test-operational-memory-control-center-query.js`

Expected: FAIL because `queryOperationalMemoryEvents()` does not exist.

- [ ] **Step 3: Implement event reads from the `events` table only**

Select only: `record_sequence`, `workflow_id`, `task_id`, `run_id`, `kind`, `reason_code`, `lesson_code`, `source_tool`, `family`, `stage_id`, `fingerprint`, `occurred_at`. Never select `start_offset`/`end_offset`; never dereference JSONL offsets.

Use bound `fingerprint`, date, workflow/project filters and deterministic keyset ordering `occurred_at DESC, record_sequence DESC`. For project/global drill-down, first resolve matching workflow IDs from `groups WHERE fingerprint = ?`, which can use the existing `groups_fingerprint_latest` index, then read each workflow via `events WHERE workflow_id = ? AND fingerprint = ?`, which can use the existing `events_workflow_fingerprint` index. Merge those bounded per-workflow streams by the event sort key. This avoids a project-wide `events` table scan without changing the SQLite schema. Project scope includes only indexes whose `index_state.project_id` equals the requested server-known ProjectId. Global drill-down accepts only a Global group that passed Task 2 safe-global eligibility; ordinary failures never become cross-project events.

- [ ] **Step 4: Add read-only failure behavior**

Skip unhealthy unrelated indexes while returning healthy results. If the specifically requested group has no healthy source, return an empty page plus controlled health context from the query layer; throw only typed validation/internal errors whose public messages contain no path or SQL.

- [ ] **Step 5: Run the drill-down tests and verify GREEN**

Run: `npm run build && node test/test-operational-memory-control-center-query.js`

Expected: PASS including forbidden-marker absence and unchanged bytes/mtimes.

- [ ] **Step 6: Commit Task 3**

```bash
git add src/workflow/operational-memory-query.ts test/test-operational-memory-control-center-query.js
git commit -m "feat: add sanitized operational memory drilldown"
```
### Task 4: Authenticated Control Center Memory API

**Files:**
- Modify: `src/control-center/server.ts`
- Modify: `test/test-tier-control-center.js`

**Interfaces:**
- Consumes: all Task 1-3 query functions.
- Produces: `GET /api/memory/overview`, `GET /api/memory/groups`, `GET /api/memory/groups/:fingerprint/events`, and `GET /api/memory/filter-options`.

- [ ] **Step 1: Add failing HTTP contract tests**

Extend the Control Center test to set `DESKTOP_COMMANDER_WORKFLOW_STATE_DIR` to an isolated fixture and assert:

```js
assert.equal((await fetch(`${controlCenter.url}api/memory/overview`)).status, 403);
const overviewResponse = await fetch(`${controlCenter.url}api/memory/overview`, { headers: tokenHeaders });
assert.equal(overviewResponse.status, 200);
assert.equal((await fetch(`${controlCenter.url}api/memory/groups?limit=201`, { headers: tokenHeaders })).status, 400);
assert.equal((await fetch(`${controlCenter.url}api/memory/groups?scope=bogus`, { headers: tokenHeaders })).status, 400);
assert.equal((await fetch(`${controlCenter.url}api/memory/groups?from=not-a-date`, { headers: tokenHeaders })).status, 400);
```

Also test SQL-injection-shaped values such as `reasonCode=' OR 1=1 --` return either a valid empty bound-parameter result or 400 under strict code validation, never broader data.

- [ ] **Step 2: Run the Control Center test and verify RED**

Run: `npm run build && node test/test-tier-control-center.js`

Expected: FAIL with Memory routes returning 404.

- [ ] **Step 3: Add strict route parsing before calling the query module**

Implement small local helpers in `server.ts` for enum/date/integer/cursor validation. `limit` defaults to 50 and must be integer 1..200; `minOccurrences` must be integer >=1; `from <= to`; `scope` defaults to `project`. Decode the fingerprint path segment once and reject empty/oversized values.
- [ ] **Step 4: Add the four GET routes behind the existing token gate**

Place Memory routing after the existing `/api/*` token check and before mutation routes. Map query-layer validation failures to HTTP 400 with controlled messages. Let unexpected failures reach the existing outer catch so the client receives only `{ error: 'Control Center request failed.' }` and no path/SQL internals.

Do not add Memory to `buildState()` and do not change mutation-origin semantics.

- [ ] **Step 5: Run Control Center and query tests and verify GREEN**

Run:

```bash
npm run build
node test/test-tier-control-center.js
node test/test-operational-memory-control-center-query.js
```

Expected: both PASS; existing approval/policy behavior remains unchanged.

- [ ] **Step 6: Commit Task 4**

```bash
git add src/control-center/server.ts test/test-tier-control-center.js
git commit -m "feat: expose read-only memory control center api"
```

### Task 5: Lazy Memory UI inside the existing Control Center

**Files:**
- Modify: `src/control-center/server.ts`
- Modify: `test/test-tier-control-center.js`
- Create: `test/test-operational-memory-control-center-ui.js`

**Interfaces:**
- Consumes: Task 4 Memory endpoints through the existing `api()` browser helper.
- Produces: a top-level Memory view with overview cards, filters, paginated groups, fingerprint copy, and sanitized event drill-down.

- [ ] **Step 1: Add failing rendered-HTML/UI contract assertions**

Assert the home HTML contains a `Memory` view trigger, memory overview/group/filter containers, but does not embed memory data or prohibited mutation labels.
```js
const html = await home.text();
assert.match(html, />Memory</);
assert.match(html, /id="memory-overview"/);
assert.match(html, /id="memory-groups"/);
assert.doesNotMatch(html, /Repair memory|Delete lesson|Promote lesson|Ignore lesson/i);
```

- [ ] **Step 2: Run the Control Center test and verify RED**

Run: `npm run build && node test/test-tier-control-center.js`

Expected: FAIL because the Memory UI markup is absent.

- [ ] **Step 3: Write a failing JSDOM interaction smoke**

Create `test/test-operational-memory-control-center-ui.js`. Start the real local Control Center with an isolated memory fixture, fetch its HTML, and load it in `JSDOM` with `runScripts: 'dangerously'`. In `beforeParse`, bridge `window.fetch` to Node `fetch` resolved against `controlCenter.url`, expose `Headers`, stub `navigator.clipboard.writeText`, and replace `window.setInterval` with a captured callback so the test controls polling deterministically. Click the Memory view trigger and assert overview/group API requests occur only after activation, a known group title/fingerprint renders through `.textContent`, a filter change issues a server query, `Load more` follows the returned cursor, and drill-down renders sanitized structural fields only. Close the JSDOM window and Control Center in `finally`.

Run: `npm run build && node test/test-operational-memory-control-center-ui.js`

Expected: FAIL before the Memory view/client functions exist.

- [ ] **Step 4: Add view navigation and lazy loading**

Keep the current main Control Center content as the default view. Add a compact view switcher with `Control` and `Memory`. On first Memory activation call `loadMemoryOverview()`, `loadMemoryFilterOptions()`, and `loadMemoryGroups({ reset: true })`. Cache only current-page client state; do not preload all history.

The existing `refresh()` and `setInterval(refresh, 2500)` continue updating only `/api/state`. They must not call any `/api/memory/*` route.

- [ ] **Step 5: Render overview and filters with safe DOM APIs**

Use `createElement()` / `.textContent`; never assign server-provided strings to `innerHTML`. Render cards for total events, unique fingerprints, projects, Errors/Limits/Lessons, index health, journal size, and last activity.

Render filters for project, kind, reason/lesson code, tool/family, stage, date range, fingerprint, and minimum occurrences. Changes reset the cursor and call the server-side group endpoint. When `filterOptions.truncated.<dimension>` is true, keep the corresponding exact-text filter usable and show a small `More values available — type an exact value` hint instead of pretending the dropdown is exhaustive. Do not perform full-dataset filtering in browser JavaScript.

- [ ] **Step 6: Render group pagination and drill-down**

Each group row shows title, project fallback, scope, occurrence count, first/last seen, kind, reason/lesson code, tool/family/stage, fingerprint, and relevance explanation. `Load more` follows `nextCursor`. Clicking a row fetches the bounded event endpoint and renders only sanitized structural fields.

Use `navigator.clipboard.writeText(item.fingerprint)` for copy when available; fallback to a temporary text input without widening CSP.
- [ ] **Step 7: Add degraded/unavailable UI states**

If index health is degraded, show counts and a neutral explanation that derived memory navigation is incomplete; do not imply execution/policy danger. If SQLite is unavailable, show Memory navigation unavailable and do not attempt JSONL fallback. API failures show a local Memory status message without disturbing Control Center policy/approval controls.

- [ ] **Step 8: Run UI/API regressions and verify GREEN**

Run:

```bash
npm run build
node test/test-tier-control-center.js
node test/test-operational-memory-control-center-ui.js
```

Expected: PASS, including the original policy/approval assertions, Memory markup/API assertions, lazy activation, filtering/pagination, and sanitized drill-down rendering.

- [ ] **Step 9: Commit Task 5**

```bash
git add src/control-center/server.ts test/test-tier-control-center.js test/test-operational-memory-control-center-ui.js
git commit -m "feat: add operational memory control center view"
```

### Task 6: 100k-event M6 scale and privacy exit gate

**Files:**
- Create: `test/test-operational-memory-control-center-scale.js`
- Modify only if profiling proves necessary: `src/workflow/operational-memory-query.ts`
- Modify only if measured query plans require an existing-schema index: `src/workflow/operational-memory-index.ts` plus its focused SQLite tests; any such change requires a fresh M3B conflict check first.

**Interfaces:**
- Consumes: completed M6 read model and existing runtime index builder for fixture setup only.
- Produces: reproducible 100k navigation evidence with measured overview, filtered group, exact fingerprint, page continuation, and drill-down timings.

- [ ] **Step 1: Write the 100k acceptance test**

Generate 100,000 valid privacy-safe JSONL events in chunks using at least two server-valid seeds: one `recordOperationalLesson()` event and one ordinary `recordOperationalToolFailure()` event. Clone only structural/validated fields while assigning unique IDs/timestamps, so the dataset exercises both lesson and error filters rather than accidentally benchmarking an empty lesson query. Build/synchronize the derived index during fixture setup through existing runtime behavior, then snapshot journal/index bytes, sizes, and mtimes before invoking any M6 function.
Measure with `performance.now()` and print one JSON line per operation:

```js
const operations = {
  overview: () => memoryQuery.getOperationalMemoryOverview(),
  filteredGroups: () => memoryQuery.queryOperationalMemoryGroups({ scope: 'project', projectId, kind: 'lesson', limit: 50 }),
  fingerprint: () => memoryQuery.queryOperationalMemoryGroups({ scope: 'project', projectId, fingerprint, limit: 50 }),
  drilldown: () => memoryQuery.queryOperationalMemoryEvents({ scope: 'project', projectId, fingerprint, limit: 50 }),
};
```

Assert each page contains at most 50 items, any cursor yields a non-overlapping continuation, exact fingerprint lookup returns the expected group, and serialized results contain none of the fake privacy markers.

- [ ] **Step 2: Establish RED before optimization**

Run: `npm run build && node test/test-operational-memory-control-center-scale.js`

Expected before completed M6: FAIL because the M6 query module/functions are absent. If run after Tasks 1-5, record the first measured M6 baseline before making any performance-specific change.

- [ ] **Step 3: Inspect actual SQLite query plans**

For the exact SQL used by M6, execute `EXPLAIN QUERY PLAN` against the 100k fixture and record whether aggregate browsing uses `project_groups`/`groups` rather than `events`, and whether fingerprint drill-down can use an existing suitable index. Do not add a database index based on intuition alone.

- [ ] **Step 4: Optimize only if the measurement shows a material scan problem**

First prefer query-shape improvements inside `operational-memory-query.ts`. Only if the 100k evidence shows event drill-down is materially non-interactive should M6 add the smallest existing-schema SQLite index needed by that exact query, with RED→GREEN coverage proving index creation/rebuild compatibility. Do not add columns, persisted prose, or a new authority table.

- [ ] **Step 5: Verify 100k GREEN and non-mutation**

Run: `npm run build && node test/test-operational-memory-control-center-scale.js`

Expected: PASS; normal browsing uses SQLite/aggregate tables, responses stay bounded, measured operations are recorded, and pre/post journal/index bytes and mtimes are unchanged.

- [ ] **Step 6: Commit Task 6**

```bash
git add test/test-operational-memory-control-center-scale.js src/workflow/operational-memory-query.ts
git add src/workflow/operational-memory-index.ts test/test-operational-memory-sqlite-index.js  # only if measurement justified it
git commit -m "test: prove operational memory control center scale"
```
### Task 7: Full verification, review, integration, and documentation

**Files:**
- Modify after successful authoritative integration: project Work Log / Owner Presentation Highlights in Google Drive.
- Remove the M6 Active Work Registry entry only after integration, intended verification, and Work Log update.

**Interfaces:**
- Consumes: the complete M6 branch from Tasks 1-6.
- Produces: verified PR into `prototype/free-pro-team`, exact merged SHA evidence, updated durable docs, and cleaned Registry state.

- [ ] **Step 1: Run focused M6 and adjacent regression suite**

```bash
npm run build
node test/test-operational-memory-control-center-query.js
node test/test-operational-memory-control-center-ui.js
node test/test-operational-memory-control-center-scale.js
node test/test-tier-control-center.js
node test/test-operational-memory.js
node test/test-operational-memory-capture-hardening.js
node test/test-operational-memory-storage-hardening.js
node test/test-operational-memory-sqlite-index.js
node test/test-operational-memory-sqlite-privacy-structure.js
node test/test-operational-memory-project-retrieval.js
node test/test-operational-memory-project-worktree-retrieval.js
node test/test-operational-memory-global-retrieval.js
node test/test-tier-policy-engine.js
node test/test-tier-policy-gate.js
node test/test-tier-control-plane-hardening.js
node test/test-open-core-boundaries.js
```

Expected: all applicable focused tests PASS. If M3B lands with a renamed test, use its integrated filename rather than silently omitting Global regression coverage.

- [ ] **Step 2: Run broad verification**

Run `npm test`, `git diff --check`, and the Engineering Playbook's current real built-MCP / prototype verification commands. Any failure must either be fixed or reproduced on the exact authoritative baseline before it is labeled non-regression.

- [ ] **Step 3: Review the complete diff**

Confirm no Memory mutation route/tool, no policy/approval/entitlement changes, no raw sensitive fields, no JSONL scan in normal M6 queries, no browser-supplied path use, and no accidental Control Center C3 split.
- [ ] **Step 4: Run independent Codex CLI read-only review**

Use Codex only as a reviewer on the exact branch commit. Ask it to inspect the full diff plus M6 spec, with emphasis on read-only guarantees, privacy leakage, Global whitelist reuse, pagination correctness, 100k behavior, and accidental security/control-plane coupling. Codex must not commit, push, merge, deploy, edit Drive/Registry, or change security/policy/approval/persistence contracts.

- [ ] **Step 5: Commit any review fixes and re-run affected verification**

For every accepted finding: add or tighten a failing regression test first when practical, implement the minimum fix, re-run focused tests plus `git diff --check`, and make a narrow follow-up commit.

- [ ] **Step 6: Push and open a PR targeting `prototype/free-pro-team`**

Verify the PR base is `prototype/free-pro-team`, not `main`. Inspect the GitHub patch against the expected head SHA and wait for required CI to complete. Do not merge on stale expected-head assumptions.

- [ ] **Step 7: Integrate and verify exact merged SHA**

After CI is GREEN, merge with expected-head protection where available. Fetch, verify `origin/prototype/free-pro-team` contains the exact merge, run required post-merge CI/checks on that SHA, and safely fast-forward the canonical `C:\DesktopCommanderTierPrototype` checkout only if it is clean and non-divergent.

- [ ] **Step 8: Sync durable documentation**

Revision-aware update the Work Log with start, RED, GREEN, scale measurements, privacy/security results, commits/PR/CI, integration, and final SHA. Update Owner Presentation Highlights only now, marking M6 VERIFIED/INTEGRATED and using only measured scale claims. Re-read Registry, remove M6 only after the Work Log update and intended verification are complete.

- [ ] **Step 9: Do not deploy unless separately authorized**

M6 completion is prototype integration plus verification. Deployment/live verification is a separate user-authorized action.

## Execution Handoff

Recommended execution mode is **Subagent-Driven**, using a fresh worker/reviewer per task and Codex CLI as an additional read-only reviewer where useful. Because M3B still owns the overlapping Operational Memory retrieval area at plan-writing time, execution begins only after a fresh Registry check shows M3B integrated/closed or the overlap is explicitly coordinated.

The first implementation action after that gate is to read `superpowers:using-git-worktrees`, create a new M6 implementation worktree from the then-current `origin/prototype/free-pro-team`, update the M6 Registry entry from planning to implementation with the new branch/SHA/scope, then start Task 1 RED.
