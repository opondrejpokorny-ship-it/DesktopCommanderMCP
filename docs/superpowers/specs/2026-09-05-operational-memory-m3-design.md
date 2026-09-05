# Operational Memory M3 — Project + Safe Global Retrieval Design

**Date:** 2026-09-05
**Status:** Owner-approved design; runtime implementation gated until B4 integration
**Baseline:** `prototype/free-pro-team` @ `5c5107467ad15db4cc2e8bd683790bcac7406183`
**Target:** `prototype/free-pro-team` via isolated PRs; never `main`

## 1. Goal

M3 makes Operational Memory useful beyond one workflow while preserving the privacy, fail-safe, and advisory-only guarantees established by M0–M2.

A new workflow should receive relevant lessons from earlier workflows of the same stable project. A second, separately integrated slice may expose only fixed-whitelist semantic lessons as safe RDC-global context.

The model-facing result remains bounded to at most eight lessons. Operational Memory remains context only and never authorizes an action, satisfies a workflow gate, consumes an approval, overrides Active Work Registry coordination, or weakens upstream validation.

## 2. Delivery decomposition

M3 is deliberately split into two independently verifiable changes:

1. **M3A — Project Memory Retrieval:** current-workflow + same-project history.
2. **M3B — Safe Global Lessons:** fixed-whitelist cross-project semantic lessons only.

M3A must be integrated and verified before M3B implementation begins. This keeps project isolation failures separate from the new global aggregation surface and gives each scope transition its own negative tests and rollback boundary.

## 3. Non-goals

M3 does not add journal rotation/archive (M4), retention/compaction (M5), Control Center Memory UI (M6), a broad model-facing memory search API (M7), or the final scale-proof tranche (M8).

It does not add vector embeddings, external databases, cloud synchronization, arbitrary semantic search, automatic deletion, Task/Run migration, or any policy/approval/security mutation.

Existing v1 JSONL journals remain readable and authoritative. M3 must not rewrite historical journal content merely to add scope metadata.

## 4. Identity and scope authority

M3 uses the Scope Architecture identity already integrated in the prototype:

- `repositoryId` is stable across linked Git worktrees for the same repository.
- the current `projectId` is deterministically derived from `repositoryId`;
- filesystem path is a resolver/location, not the semantic project identity.

Therefore M3A may correlate history across linked worktrees only when stored server-derived scope metadata exactly matches the current `projectId`. Under the current one-repository project model, matching `repositoryId` is also required when both sides provide it.

A candidate index with missing, malformed, incompatible, or mismatched scope metadata is ignored. M3 never guesses project identity from similar paths, branch names, repository directory names, or model-provided text.

SQLite scope metadata is retrieval correlation, not authorization. Policy, approvals, Registry state, current source, and upstream validation remain independently authoritative.

## 5. M3A storage/read-model changes

M3A extends the per-journal derived SQLite schema with a project-level aggregate. The preferred schema is a version bump from M2 schema v3 and a new `project_groups` table keyed by fingerprint.

`project_groups` stores structural, sanitized metadata only:

- fingerprint;
- latest kind/reason/lesson code/source tool/family/stage id;
- first seen / last seen;
- total occurrences;
- number of distinct workflows in which the fingerprint appeared;
- latest workflow id and latest record sequence.

The existing `events`, workflow-scoped `groups`, and `index_state` remain. Append synchronization updates event + workflow group + project group + checkpoint in one SQLite transaction after the authoritative JSONL append succeeds.

A full SQLite rebuild recreates both workflow and project aggregates from complete valid JSONL records. An incomplete final JSONL fragment remains uncheckpointed exactly as in M2.

Distinct-workflow count is incremented only when a fingerprint is first observed in that workflow. This provides a bounded signal that a lesson recurred across separate work attempts instead of rewarding a single noisy workflow indefinitely.

No raw result text, raw MCP arguments, terminal commands/output, file contents, credentials, approval payloads, or arbitrary prose is added to SQLite.

## 6. M3A retrieval flow

For `project_workflow status/resume`, retrieval proceeds in layers:

1. synchronize/read the current project-root index and preserve the existing exact-workflow candidate set;
2. read the current index's project aggregate;
3. discover other compatible Operational Memory SQLite indexes under the protected workflow-state root;
4. accept a historical index only when schema validation succeeds and its `projectId` matches the current server-derived `projectId` (plus current `repositoryId` when present under the repository-derived project model);
5. query only aggregate rows from accepted indexes, not their entire event history;
6. merge, deduplicate, rank, and cap the final result to eight lessons.

The same fingerprint may exist at multiple scopes. Deduplication keeps one model-facing lesson, preferring the narrowest applicable scope: current workflow over project over global. Broader aggregate counts may influence ranking internally but do not cause duplicate lesson text to enter model context.

M3A does not perform an O(total journal history) scan during normal status/resume. Historical worktree indexes are bounded derived read models; incompatible or unavailable candidates are skipped.

If project-history discovery or aggregation fails, current-workflow retrieval still succeeds through the M2 SQLite path or existing bounded JSONL fallback. A project-memory failure must not make `project_workflow` unavailable.

## 7. Ranking, cap, and relevance explanation

`OperationalMemoryLesson` gains additive fixed fields:

- `scope: 'workflow' | 'project' | 'global'`;
- `relevanceReason`: a server-defined enum/string, never model-authored prose.

Existing fields remain for compatibility, including `relevanceScore`. The hard cap remains eight lessons total.

Ranking uses deterministic score bands so scope/relevance dominates raw frequency. Within a band, recurrence has a saturating contribution and recency is only a bounded tie-breaker.

M3A reasons are limited to fixed categories such as:

- `workflow_exact_stage`;
- `workflow_stage_family`;
- `workflow_history`;
- `project_exact_stage`;
- `project_stage_family`;
- `project_repeated`;
- `project_recent`.

Current `status/resume` provides stage context but not an explicit current tool or reason query. M3 therefore preserves the existing stage/tool-family heuristic and does not invent unavailable tool/reason matching. Source tool and reason remain structural lesson metadata and grouping inputs.

Project recurrence weighting uses a capped combination of occurrence count and distinct-workflow count. No amount of repetition may lift a weak project/global candidate above an exact current-workflow/stage match.

## 8. M3A security and negative behavior

Cross-project isolation is fail-closed for retrieval. A memory index from project B must never contribute a project-scoped lesson to project A merely because the fingerprint, workflow stage, branch name, or local directory layout is similar.

Linked worktrees of the same repository may share project history because their stable project/repository identities match. If a historical index lacks usable stable identity metadata, it is omitted instead of path-matched.

A malformed/corrupt historical SQLite file cannot block current workflow memory. It is skipped; the current index follows M2 rebuild/fallback rules.

Memory remains non-authoritative. Returned scope/relevance metadata cannot satisfy lifecycle evidence, change Registry ownership, grant policy ALLOW, approve a request, or bypass upstream validation.

## 9. M3B global derived store

M3B introduces a separate local, disposable, rebuildable global read model under the protected workflow-state root. It is not added to every per-project database and is not an authority source.

The global store contains only fixed-whitelist semantic `OperationalLessonCode` aggregates. Eligible source events must pass the existing server parser and be structurally consistent with the whitelisted learning path: `kind=lesson`, `reasonCode=learned_pattern`, `sourceTool=project_workflow`, derived `family=workflow`, valid `lessonCode`, server-recomputed fingerprint, and server-controlled template reconstruction.

Ordinary tool failures, policy denials, approval-required events, arbitrary fingerprints, client prose, and unknown lesson codes are never globally promoted.

Preferred global rows contain only lesson code, first/last seen timestamps, bounded occurrence metadata, and rebuild/checkpoint metadata. Human-readable summary/lesson text is reconstructed from `OPERATIONAL_LESSON_TEMPLATES` at read time.

## 10. M3B synchronization and recovery

After a successful authoritative JSONL append of an eligible whitelisted lesson, global-index maintenance is best-effort and transactional. Failure to update the global index never turns a successful journal append into failure.

The global store tracks per-journal source checkpoints using privacy-safe source identifiers derived from journal filenames/state metadata rather than storing project paths. Normal reconciliation processes only changed sources.

A missing, stale, or corrupt global store is rebuilt from privacy-safe Operational Memory journals (or synchronized per-project derived indexes that themselves are first validated/rebuilt from those journals). JSONL remains the ultimate recovery source.

Rebuild uses atomic replacement: an old valid global index remains readable until the replacement is complete. Concurrent writers/readers use bounded SQLite busy handling and transactions; partial global maintenance is never treated as authoritative state.

If SQLite/global reconciliation is unavailable, M3B simply omits global candidates. Workflow and project retrieval remain functional.

## 11. M3B relevance

Global candidates are always lower priority than relevant workflow/project candidates. Repetition is saturated so global frequency cannot dominate the bounded context.

Global applicability is server-defined. If stage-aware boosting is used, it comes from a fixed mapping from `OperationalLessonCode` to broad stage classes derived from the existing stage-id heuristic; no project/model text may define global applicability.

Global `relevanceReason` is a fixed category such as `global_whitelist_stage_match` or `global_whitelist`. Exact project stage names from another project are not treated as globally meaningful evidence.

## 12. M3A RED→GREEN verification plan

Focused expected-RED coverage must prove the behavior absent on the M2 baseline before implementation:

- a new workflow initially cannot retrieve a prior workflow lesson, then can after M3A;
- an old lesson outside the 512 KiB tail can still be retrieved from the project aggregate;
- same-project linked worktrees share project history through stable identity;
- a different repository/project cannot receive that project history;
- same fingerprint in workflow + project returns once with workflow scope;
- frequency saturation prevents a noisy project lesson from outranking an exact workflow/stage lesson;
- total model-facing lessons never exceed eight;
- every returned lesson has a fixed scope and relevance reason;
- corrupt/missing/mismatched historical indexes are skipped without breaking current workflow retrieval;
- privacy tests prove project aggregates contain structural fields only.

M3A also runs the full existing M0/M1/M2 Operational Memory regression set, Scope Identity/worktree correlation tests, `project_workflow` coordinator tests, build/typecheck, real built-MCP status/resume where practical, open-core/policy regressions, `git diff --check`, PR CI, and exact merged-SHA post-merge CI.

## 13. M3B RED→GREEN verification plan

Focused tests must prove:

- a whitelisted semantic lesson learned in project A can appear as global context in project B;
- a normal tool failure from project A never appears globally in project B;
- unknown/spoofed lesson codes, arbitrary prose, and a valid lesson code presented through a non-`project_workflow` source tool cannot enter the global store;
- project-specific lessons remain isolated even when global retrieval is enabled;
- global corruption/unavailability only removes global candidates and cannot break workflow/project memory;
- rebuild reproduces global aggregates from authoritative journals;
- concurrent updates cannot create partial/corrupt global rows;
- global schema/checkpoints persist no raw commands, args, file contents, secrets, approval payloads, or project paths;
- global repetition cannot exceed workflow/project relevance bands or the eight-lesson cap.

## 14. Integration and exit gates

### M3A exit gate

M3A is complete only when a fresh workflow retrieves relevant same-project history, linked-worktree correlation is proven, cross-project negative tests pass, fallback preserves current workflow memory, and the exact merged prototype SHA passes intended CI.

After M3A integration, Work Log and Owner Presentation Highlights may state that project history survives across workflows. They must not claim global retrieval yet.

### M3B exit gate

M3B is complete only when safe fixed-whitelist lessons can cross projects, non-whitelist/project-specific data cannot, rebuild/fallback/concurrency/privacy tests pass, and the exact merged prototype SHA passes intended CI.

Only after M3B may the roadmap describe the M0–M3 core reliability/scalability tranche as integrated.

## 15. Deployment and presentation boundary

Neither M3A nor M3B is deployed merely because it is merged. Deployment requires explicit user authorization and separate live verification.

For the owner presentation, the intended claim after M3 completion is narrow: Desktop Commander can carry privacy-safe operational lessons across workflows of the same project and can reuse only explicitly safe semantic lesson codes globally, while keeping memory bounded and non-authorizing.

M6 will make that learned state visible to humans. Selected M8 proof will provide presentation-grade scale/recovery/security evidence. Those phases remain separate work after M3.
