# Operational Memory M3 — Post-B4 Design Amendment (DRAFT)

**Date:** 2026-09-05
**Status:** DRAFT — not owner-approved; no runtime implementation may rely on this until reviewed after B4 integration
**Amends:** `2026-09-05-operational-memory-m3-design.md`
**Reason:** Scope B4 introduces server-owned TaskId/RunId after the original M3 design was approved.

## 1. What remains unchanged

M3 is still split into M3A Project retrieval and later M3B safe Global lessons.
JSONL remains durable authority; SQLite remains derived/rebuildable.
The model-facing hard cap remains eight lessons.
Returned high-level scope remains `workflow | project | global` so the existing M3/M6 roadmap contract does not fork.
Memory remains advice/context only and cannot authorize, approve, satisfy Registry coordination or bypass upstream validation.

## 2. B4 identity amendment

For WorkflowState v2, B4 guarantees `workflowId == taskId` and a server-owned current `runId`.
`status` is observational and never rotates RunId.
Explicit `resume` preserves TaskId/workflowId and rotates RunId.
A new/restarted task creates a new TaskId and RunId.
Legacy v1 has no RunId; its TaskId correlation is the existing workflowId and no historical RunId may be invented.

M3 therefore treats TaskId and RunId as correlation/relevance metadata inside the existing `workflow` retrieval scope, not as new authorization or policy scopes.
## 3. Event and index correlation

New v2-workflow Operational Memory events may add optional structural `taskId` and `runId` fields while keeping the existing JSONL event version readable.
For v2-produced events, `taskId` must equal `workflowId` and `runId` must come only from the parsed server-owned WorkflowState.
For legacy events without Task/Run fields, retrieval may interpret `workflowId` as TaskId correlation but must leave RunId absent.
Historical JSONL is never rewritten merely to backfill these fields.

The derived SQLite schema may add sanitized task/run columns needed for indexed ranking and recovery.
No task/run field changes the privacy boundary: raw MCP args, raw commands/output, file contents, credentials, approval payloads and arbitrary client prose remain forbidden.

## 4. M3A retrieval precedence after B4

Within the existing high-level scopes, relevance becomes:
1. current Run + exact current stage;
2. current Run + matching stage family;
3. current Task history across prior Runs;
4. same Project history across prior Tasks/workflows and compatible linked worktrees;
5. safe Global candidates only in M3B.

Run/Task recurrence bonuses are bounded. No repeated Task/Project lesson can outrank an exact current-Run/stage match.
A duplicate fingerprint still produces one model-facing lesson; narrower/current correlation wins.
The final model-facing list remains capped at eight.
## 5. Historical linked-worktree discovery hardening

Normal status/resume must not rebuild or synchronize unrelated project indexes merely because they exist under the shared workflow-state root.
Discovery first opens candidate SQLite files read-only and inspects only validated `index_state` correlation metadata.
Candidates whose `projectId` or repository correlation does not match are closed and ignored before any journal synchronization.
Only candidates already identified as the same stable Project/Repository may be reconciled against their corresponding journal and queried for sanitized aggregates.
A missing/corrupt candidate whose identity cannot be established is skipped rather than path-guessed or rebuilt as a side effect of another project's status request.
The current project's own index keeps the existing M2 rebuild/fallback behavior.

## 6. Current Task versus Project aggregate

The current per-workflow `groups` rows become current-Task aggregate rows because B4 preserves `workflowId == taskId` across Runs.
Current-Run specificity comes from indexed events carrying the current RunId.
The approved `project_groups` aggregate may therefore continue to include all Tasks; if a fingerprint also exists in the current Task, the current-Task/workflow candidate wins deduplication.
This avoids inventing a second Task scope while still preventing Project aggregate frequency from replacing current Task/Run context.

## 7. Required B4-aware tests

In addition to the approved M3A matrix, prove:
- current Run lessons outrank prior-Run lessons from the same Task;
- `resume` rotates RunId but preserves access to prior-Run Task lessons;
- a new Task does not inherit workflow scope from the previous Task, only Project scope;
- legacy v1 events expose no fabricated RunId;
- malformed/spoofed TaskId/RunId fields are rejected or ignored according to the server parser contract;
- linked-worktree discovery does not mutate/rebuild a mismatched project's index.
## 8. M3B authority note

The current Operational Memory roadmap additionally requires any Global promotion/assertion to have durable sanitized authority; a SQLite-only Global aggregate is insufficient.
The approved M3B design already keeps SQLite derived, but its exact Global authority representation must be reconciled before M3B implementation.
M3A does not need to solve this and must not introduce a premature Global write path.

## 9. Approval/integration gate

This amendment is intentionally a draft while B4 is still uncommitted and active in the Registry.
After B4 is authoritatively integrated, re-read its exact merged source/tests and update this draft only if the final contract differs.
Then obtain explicit owner approval of this amendment before writing M3A RED tests or runtime code.
The original approved M3 design remains the current approved design until that happens.

## 10. Live B4 compatibility evidence (pending final merge)

Read-only review of B4 head `060576726e457391023e90680ffea9140894073f` plus its current local hardening confirms the intended trust boundary:
- v2 `workflowId`, `taskId`, and `runId` are server-state UUIDs and `taskId == workflowId`;
- current uncommitted B4 hardening also requires legacy/v2 `workflowId` itself to be a valid UUID before status/resume or Operational Memory association;
- `operational-memory.ts` validates v2 Task/Run fields today but intentionally drops them from its reduced `PersistedWorkflowState`, because B4 keeps Operational Memory behavior unchanged;
- M3A must preserve those already-validated fields in that internal reduced state before using them for correlation;
- the two Operational Memory event construction paths (`recordOperationalToolFailure` and `recordOperationalLesson`) both derive workflow state internally, so Task/Run metadata need not become client-trusted input;
- the current v1 JSONL parser reconstructs a sanitized event and ignores unknown extra fields; therefore M3A must explicitly validate and return optional Task/Run fields or they would disappear during SQLite rebuild/reload;
- the M3 SQLite schema bump should carry optional Task/Run columns alongside `project_groups`, with legacy rows leaving RunId absent;
- Task/Run do not enter the semantic fingerprint: the same operational lesson should deduplicate across Runs/Tasks while scope/correlation determines precedence.

This evidence does not release the B4 gate. Re-check the exact merged B4 source and tests before converting this draft into the approved post-B4 amendment.

## 11. Trusted scope context handoff

Repository-wide call-site review found one production caller of `getOperationalMemorySummary`: `project-workflow.ts::toStatus`.
After B4, `toStatus` already holds the strictly parsed server-owned WorkflowState and returns its TaskId/RunId in WorkflowStatus.
M3A should therefore extend `getOperationalMemorySummary` with an additive optional final scope-context argument carrying validated `taskId` and optional `runId`, supplied directly by `toStatus`.
This avoids rereading/reparsing workflow state inside retrieval and keeps Task/Run provenance server-owned.
The argument remains internal correlation/relevance context only; it is not a public MCP input and cannot grant authorization.
Because the production call-site blast radius is one, `src/workflow/project-workflow.ts` should be included explicitly in the M3A implementation scope alongside Operational Memory and its index.