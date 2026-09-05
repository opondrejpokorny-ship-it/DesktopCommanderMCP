# Operational Memory M6 — Control Center Human Navigation Design

Date: 2026-09-05
Status: approved architecture; written specification pending user review
Baseline: `prototype/free-pro-team` @ `98707d670b64bd8fed0eb3e673f6a648a498af64`

## Goal

Add a human-facing, read-only Operational Memory view to the existing local Desktop Commander Control Center so a user can inspect what RDC has learned, filter large histories, and drill into sanitized metadata without opening JSONL manually.

The M6 exit gate is: **a human can find a specific lesson among 100k+ events without manually reading the journal**.

M6 is a navigation/read-model feature only. It does not change what memory can authorize, how policy or approvals work, or which memory records are authoritative.

## Authority and dependencies

The authority hierarchy remains unchanged:

- privacy-safe JSONL journals are the durable Operational Memory authority and recovery source;
- SQLite is derived, local, disposable and rebuildable;
- `prototype/free-pro-team` is the authoritative product branch;
- Active Work Registry coordinates unfinished parallel work;
- policy, approval, upstream validation and explicit user authorization remain security authorities;
- Operational Memory is advisory/context only.

M3A project retrieval is already integrated. M3B Safe Global Retrieval is still active in a separate worktree at the time this specification is written. M6 implementation must begin from the then-current authoritative prototype after M3B is integrated or after the overlap is explicitly coordinated. This specification does not define a competing Global-memory authority or change M3B persistence/retrieval contracts.

Commercial C2 work is also active but explicitly excludes Control Center split and Operational Memory/shared-scope contracts. M6 must not modify commercial policy-runtime, approval, entitlement or protected-resource semantics.

## Current architecture

The local Control Center is currently implemented in `src/control-center/server.ts` as one loopback HTTP server with inline HTML/CSS/JavaScript.

Existing protections include:

- loopback binding by default;
- per-session token sent in `x-dc-control-token`;
- token validation for every `/api/*` route;
- local Host validation;
- local-origin checks for mutation routes;
- `Cache-Control: no-store`, `X-Content-Type-Options: nosniff`, `X-Frame-Options: DENY`, `Referrer-Policy: no-referrer`, `Cross-Origin-Resource-Policy: same-origin`, and restrictive CSP headers.

The existing UI polls `/api/state` every 2.5 seconds. M6 must not put large memory payloads into `/api/state`; doing so would make the existing global poll increasingly expensive as memory grows.

The current SQLite index stores sanitized event and aggregate fields such as workflow/task/run IDs, kind, reason/lesson code, source tool, family, stage, fingerprint, occurrence timestamps/counts, projectId/repositoryId correlation, record counts and index-state metadata.

Current Operational Memory retrieval helpers call `ensureOperationalMemoryIndex()`, which may synchronize or rebuild an index. That behavior is appropriate for runtime memory recovery but is not appropriate for a UI whose initial contract is read-only. M6 therefore needs a separate read-only query boundary rather than calling those mutating/recovery helpers directly from Control Center handlers.

## Architectural decision

Use a three-layer read path:

`Control Center Memory UI -> local /api/memory/* endpoints -> Operational Memory read-only query module -> existing SQLite indexes + filesystem metadata`

The UI never opens JSONL, SQLite, workflow-state files or arbitrary filesystem paths directly.

The Control Center server never contains ad-hoc SQL. All memory enumeration, validation, filtering, pagination, aggregation and sanitization belong to a dedicated read-only module under the Operational Memory/workflow area.

The query module opens existing SQLite indexes read-only and may `stat` corresponding journals/indexes to report health and size. It must not:

- call index rebuild/synchronization helpers;
- create, replace, repair, quarantine or delete an index;
- append or rewrite a journal;
- promote, ignore, retain or delete lessons;
- mutate policy, approvals, workflow state or Active Work state.

If normal RDC runtime activity later repairs/rebuilds an unhealthy derived index, a subsequent Memory refresh can observe the new state. Merely opening or filtering the Memory UI must not cause that mutation.

## Proposed source boundary

Implementation should introduce a dedicated module, provisionally:

`src/workflow/operational-memory-query.ts`

The exact filename may change during implementation if the integrated M3B structure makes another name materially cleaner, but the boundary must remain separate from the Control Center HTTP/UI code.

The module should expose typed, sanitized functions conceptually equivalent to:

- `getOperationalMemoryOverview(query?)`
- `queryOperationalMemoryGroups(query)`
- `queryOperationalMemoryEvents(query)`
- `getOperationalMemoryFilterOptions(query?)`

It owns discovery of memory indexes under the protected workflow-state root, read-only SQLite access, schema/index-state validation, project deduplication, keyset pagination and response sanitization.

Where user-facing lesson/summary text is required, it must be reconstructed from server-controlled `reasonCode` / `lessonCode` templates or another equally strict server-controlled mapping. Arbitrary persisted or client-supplied prose must not become trusted display content.

A small pure presentation/sanitization helper may be extracted from existing Operational Memory code if needed after M3B integration. Avoid a large refactor merely to implement M6.

## Project and scope model

Project identity is based on server-controlled stable `projectId`, with `repositoryId` correlation when present. A filesystem path is not the project identity and must not be accepted from a Control Center query parameter.

For user display, the API may return a server-derived `displayName` when a safe project label is already available. Otherwise the UI should use a short stable fallback such as `Project <short-project-id>`. M6 does not require exposing raw project-root paths.

The grouped view supports three semantic perspectives:

- `workflow`: fingerprint aggregated within one workflow/task/run context;
- `project`: fingerprint aggregated across history belonging to the same verified ProjectId;
- `global`: only the safe Global lesson model that is authoritative after M3B integration.

Default grouped browsing should use `project` scope because it gives the most useful human overview without duplicating every workflow occurrence. Every returned group includes an explicit `scope`.

If the same project appears through multiple journals/worktrees, overview project counts are deduplicated by ProjectId and project-scope groups are merged by ProjectId + fingerprint. RepositoryId remains correlation metadata, not authorization.

Global scope must consume the integrated M3B safe read model. M6 must not infer Global lessons by scanning arbitrary project failures or by promoting records in the UI.

## HTTP API

All M6 endpoints remain local Control Center endpoints protected by the existing session-token requirement. They are **not MCP tools** and are not model-facing APIs.

### `GET /api/memory/overview`

Returns lightweight aggregate status only.

Response shape should be equivalent to:

```ts
interface MemoryOverviewResponse {
  generatedAt: string;
  totalEvents: number;
  uniqueFingerprints: number;
  projectsWithMemory: number;
  countsByKind: {
    error: number;
    limit: number;
    lesson: number;
  };
  journalBytes: number;
  indexBytes: number;
  lastActivityAt?: string;
  indexHealth: {
    overall: 'healthy' | 'degraded' | 'unavailable';
    healthy: number;
    stale: number;
    missing: number;
    corrupt: number;
    orphaned: number;
  };
}
```

`totalEvents` is a count of validated/indexed events represented by the discovered memory indexes, not the number of rows returned by the current page. `projectsWithMemory` is unique by projectId where correlation exists.

### `GET /api/memory/groups`

Structured filters:

- `projectId`
- `scope=workflow|project|global`
- `kind=error|limit|lesson`
- `reasonCode`
- `lessonCode`
- `sourceTool`
- `family`
- `stageId`
- `from`
- `to`
- `fingerprint`
- `minOccurrences`
- `limit`
- `cursor`

Default `scope` is `project`. Default `limit` is 50. Hard maximum is 200.

Unknown enum values, malformed dates, invalid occurrence counts, invalid cursor values and out-of-range limits return HTTP 400. User values are always bound parameters, never interpolated SQL.

Results use deterministic keyset pagination, not unbounded result sets and not full in-memory sorting of the complete database. The preferred order is:

`lastSeenAt DESC, projectId ASC, fingerprint ASC, scope ASC`

The cursor is opaque to the client and encodes only the bounded sort position needed for the next page. It is not an authority token.

Representative sanitized item:

```ts
interface MemoryGroupItem {
  projectId: string;
  repositoryId?: string;
  projectDisplayName?: string;
  scope: 'workflow' | 'project' | 'global';
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
  firstSeenAt: string;
  lastSeenAt: string;
  relevanceExplanation: string;
}
```

`title`, `lesson` and `relevanceExplanation` are server-controlled text. The relevance explanation for human browsing need not pretend to have the current model workflow context. It may use controlled explanations such as “repeated across N workflows”, “latest lesson in this project”, or “server-whitelisted Global lesson”.

### `GET /api/memory/groups/:fingerprint/events`

Returns a sanitized event timeline for one group. Required disambiguation such as `projectId` and `scope` is supplied as validated query parameters because the same fingerprint may occur in multiple projects/scopes.

Filters may additionally narrow by date. Use the same bounded `limit`/opaque cursor pattern, with a default of 50 and maximum of 200.

Allowed event fields are limited to:

- event ID only if already a server-generated opaque ID is safely available;
- projectId / repositoryId correlation;
- workflowId;
- taskId;
- runId;
- kind;
- reasonCode;
- lessonCode;
- sourceTool;
- family;
- stageId;
- fingerprint;
- occurredAt.

Record byte offsets, raw JSON lines, arbitrary stored text and filesystem paths are not useful to the human navigation goal and should not be returned.

### `GET /api/memory/filter-options`

Returns bounded distinct values needed for dropdowns, such as projects, kinds, reason/lesson codes, tools/families and stages. It must not materialize unbounded arbitrary strings. Values originate only from the sanitized indexed schema/server-controlled codes.

If implementation can populate a filter from the paginated group endpoint without extra cost, this endpoint may be omitted; the architectural requirement is bounded, server-sanitized filter data, not a mandatory fourth route.

## Index discovery and health

The read-only query module enumerates only expected `*.memory.sqlite` / corresponding authority-journal locations under the protected workflow-state root. API callers cannot supply a path.

For every discovered memory unit, health is classified without repairing it:

- `healthy`: SQLite opens read-only, schema/index-state is compatible, and journal filesystem metadata/checkpoint evidence is consistent enough for read navigation;
- `stale`: a valid index exists but its recorded authority metadata does not match the current journal;
- `missing`: a journal exists but its derived index does not;
- `corrupt`: SQLite cannot be opened/validated or required schema/index-state is invalid;
- `orphaned`: an index exists without its corresponding authority journal.

If built-in SQLite is unavailable, overall health is `unavailable`; the Memory UI reports that state rather than scanning full JSONL as a substitute.

The UI may explain that normal RDC recovery can rebuild derived state, but M6 ships no “Repair”, “Rebuild”, “Delete”, “Ignore” or similar mutation button.

## UI design

M6 remains inside the current Control Center; it is not the later C3 Control Center split.

Add a top-level `Memory` view/tab/section alongside existing Control Center content. Existing `/api/state` behavior and its 2.5-second polling stay independent.

Memory data is loaded only when the Memory view is opened and when the user:

- changes a filter;
- requests the next page;
- opens a drill-down;
- explicitly refreshes.

The first M6 version should not poll large group/event endpoints every 2.5 seconds.

### Overview

Show compact cards for:

- total events;
- unique lesson fingerprints;
- projects with memory;
- Errors / Limits / Lessons;
- index health;
- journal size;
- last memory activity.

If health is degraded, show the count/status plainly without implying policy or execution is unsafe. Memory index health is not an authorization verdict.

### Group list

Display:

- friendly title;
- project;
- scope;
- occurrence count;
- first/last seen;
- kind;
- reasonCode / lessonCode;
- tool + family + stage;
- fingerprint;
- controlled relevance explanation.

Fingerprint should support one-click copy because it is the most precise lookup key for support/debugging.

### Filters

Expose all roadmap filters:

- project;
- kind;
- reasonCode / lessonCode;
- tool/family;
- stage;
- date range;
- fingerprint;
- minimum occurrence count.

Filters are server-side. Do not download the full dataset and filter in the browser.

### Drill-down

Selecting a group opens a detail panel or expandable row with the sanitized chronological event timeline. The view never includes raw command text, command output, MCP arguments/results, file content, credentials, approval payloads or raw JSONL.

## Privacy and security invariants

M6 must preserve all existing Control Center protections and all Operational Memory privacy rules.

Non-negotiable requirements:

1. every `/api/memory/*` request requires the existing per-session Control Center token;
2. bind/Host/CSP/no-store protections remain unchanged;
3. no Memory mutation endpoint is introduced;
4. no MCP/model-facing Memory browsing/editing tool is introduced;
5. no path supplied by the browser is used for index/journal discovery;
6. all query parameters are strict allowlisted values or safely bound text filters;
7. no raw MCP args/results, terminal commands/output, file contents, credentials/API keys, approval payloads or arbitrary client prose are returned;
8. server-controlled template reconstruction is used for friendly lesson text;
9. memory health, scope, occurrence count or relevance can never grant `ALLOW`, consume approval, suppress `DENY`, bypass Active Work or weaken upstream validation;
10. UI-only restrictions are not treated as a security boundary; the server response itself is sanitized.

Future ignore/promote/retention/delete controls require a separate human-control design and security review. They are explicitly out of M6.

## Performance and scaling

Normal M6 browsing must operate from the derived SQLite indexes and filesystem metadata, not by rescanning JSONL history.

Implementation should add/select indexes needed for the actual measured M6 queries only after profiling on realistic fixtures. Do not guess broad database indexes in the design phase.

The M6 acceptance dataset is 100k+ events. M8 later extends scale proof to 1M events and wider recovery/security verification.

No arbitrary latency threshold is frozen in this design. The implementation plan must first measure representative overview, filtered group lookup, fingerprint lookup, pagination and drill-down on `WIN-A0OFGC4ORFI` and CI where practical, then record the measured baseline. The acceptance requirement is that normal queries use indexed/keyset paths and remain interactively usable without work proportional to total JSONL bytes.

Queries must remain bounded in memory and response size. Hard maximum page size is 200.

## Failure behavior

Memory browsing failures are isolated from execution/control-plane behavior.

- one unhealthy project index does not prevent healthy project results from being returned;
- the overview reports partial/degraded health;
- a group/detail request targeting unavailable data returns a bounded structured error or empty result with health context, not raw SQLite errors;
- no query failure mutates authority or security state;
- no query failure changes policy/approval decisions;
- invalid API filters return HTTP 400;
- unexpected internal query failures return a generic HTTP 500 response without paths, SQL text or sensitive internals.

## Implementation boundaries

Expected implementation areas after written-spec approval and after a fresh Registry/baseline audit:

- new read-only Operational Memory query module and focused tests;
- minimal exports/pure helper extraction from Operational Memory only where necessary;
- `src/control-center/server.ts` read endpoints and Memory UI;
- focused Control Center integration tests;
- M6 scale/privacy fixtures/tests.

Do not implement M6 by:

- adding memory payloads to the existing `/api/state` poll;
- querying SQLite directly inside browser JavaScript;
- querying SQLite ad hoc in route handlers;
- calling `ensureOperationalMemoryIndex()` from the Memory HTTP read path;
- scanning all JSONL on each request;
- exposing a broad MCP memory-search tool;
- introducing memory edits/promotions/deletion;
- changing policy, approval, entitlement, Active Work or upstream safety behavior;
- splitting Control Center into a new product/application as part of M6.

## RED -> GREEN verification plan

Implementation begins only after the user approves this written spec and an implementation plan is produced with the Superpowers `writing-plans` workflow.

Expected RED coverage before production changes:

1. authenticated `/api/memory/overview` does not yet exist;
2. unauthenticated Memory API access is rejected;
3. group filtering/pagination contract does not yet exist;
4. drill-down sanitization contract does not yet exist;
5. missing/corrupt/stale index health reporting does not yet exist;
6. 100k+ indexed navigation exit-gate test does not yet exist;
7. fake sensitive fields/strings cannot appear in Memory API responses;
8. opening Memory must not rebuild/synchronize/mutate journal or SQLite state.

GREEN verification must include:

- focused query-module tests;
- Control Center integration tests, extending/supplementing `test/test-tier-control-center.js`;
- strict filter validation and SQL-injection-style negative cases;
- cross-project projectId isolation and linked-worktree/project deduplication;
- Global results restricted to the integrated M3B safe Global model;
- 100k+ event overview/filter/fingerprint/pagination/drill-down verification;
- missing/stale/corrupt/orphaned/unavailable index behavior;
- fake secret, raw command, raw MCP args/results, file-content and approval-payload negative privacy checks;
- proof that read requests do not alter journal/index bytes or timestamps where the operating system makes that assertion reliable;
- build/typecheck/lint where applicable;
- existing Operational Memory M0-M3 regressions;
- existing Control Center, policy, approval, open-core and relevant scope regressions;
- real built-MCP checks where applicable to ensure M6 did not disturb workflow memory behavior;
- `git diff --check`;
- full diff review;
- PR/CI to `prototype/free-pro-team`;
- exact merged-SHA post-merge CI and local verification as required by the Engineering Playbook.

Baseline-only failures must be reproduced on the exact authoritative baseline before being classified as non-regressions.

## Acceptance criteria

M6 is complete only when all of the following are true:

- the user can open Memory in the local Control Center and inspect overview metrics;
- the user can filter groups by every roadmap-required filter;
- the user can find an exact fingerprint among a 100k+ event dataset using indexed queries;
- group results are paginated and bounded;
- a group can be drilled into as a sanitized event timeline;
- multiple journals/worktrees belonging to one ProjectId do not inflate the project count or break project-level navigation;
- Global results, if shown, come only from the integrated safe M3B Global model;
- unhealthy/missing derived indexes are visible as health state without UI-triggered repair;
- opening/filtering/drilling down does not mutate Operational Memory state;
- no prohibited sensitive payload reaches the browser/API response;
- no policy, approval, Active Work, entitlement or upstream validation behavior changes;
- intended tests/build/checks/CI pass and exact merged prototype SHA is verified;
- Work Log and Owner Presentation Highlights are updated only with capabilities actually VERIFIED / INTEGRATED;
- Registry entry is removed only after authoritative integration, intended verification and Work Log update.

## Out of scope

M6 does not include:

- journal rotation/archive (M4);
- destructive retention/compaction (M5);
- model-facing broad Memory read/search/edit API (M7);
- 1M-event full production hardening tranche beyond any implementation profiling needed here (M8);
- cloud-hosted memory, vector DB or embeddings;
- cross-device Team memory synchronization;
- memory promotion/ignore/delete/retention actions;
- Control Center architectural split (C3);
- policy, approval, entitlement or audit authority changes;
- deployment.

## Owner-facing presentation boundary

After authoritative integration and verification, M6 may support the owner-facing message:

> Desktop Commander can learn privacy-safe operational lessons over long-running work, and the user can inspect what the system has learned without turning memory into an authorization mechanism.

Until M6 is integrated and verified on the authoritative prototype, the Memory UI must be described as designed/in progress rather than implemented.
