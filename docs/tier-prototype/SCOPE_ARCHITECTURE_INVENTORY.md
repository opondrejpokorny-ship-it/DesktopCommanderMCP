# Scope Architecture Inventory

Date: 2026-09-04
Baseline: `prototype/free-pro-team` @ `6aa1eb7ceff2ff4b12c8bc2e4ddc51c2cf0cc295`
Status: B0 characterization; no production behavior change

## Purpose

This inventory separates where an RDC capability is implemented from the ownership/lifetime of the state it manages. Target ownership is `RDC -> Project/Repository -> Task/Run -> Action`, with Device as orthogonal correlation context.

## Current identity/storage findings

### Project workflow state

Current key: canonicalized resolved `projectRoot` path -> SHA-256 digest (24 hex chars).
Storage: `<workflow-state-root>/<digest>.json`.
State owns one current `workflowId`, `projectRoot`, goal, profile/fingerprint, stage states/evidence, Git baseline/current snapshots and completion timestamps.
Current limitation: physical checkout path acts as project identity; task and run are represented implicitly by one replaceable `workflowId` rather than stable explicit IDs.
Target ownership: Project + Task/Run.
Security role: lifecycle/evidence guidance only; never policy or approval authority.

### Operational Memory journal

Current key: same project-root path digest as workflow state.
Storage: `<workflow-state-root>/<digest>.memory.jsonl`.
Each event carries `workflowId`; normal retrieval filters to only that active workflow ID. Reader is bounded to 512 KiB tail / 1000 parsed events and returns at most 8 lessons.
Current limitation: journal is physically project-like but reusable history is workflow-only; old project lessons remain on disk yet are not normally retrieved.
Target ownership: durable journal correlated to Project, with event applicability `workflow | project | global_rdc`; Task/Run/Action correlation added later.
Security role: advisory context only; server validates event shape/fingerprint and uses whitelisted semantic lesson text.

### Active Work Registry

Current repository identity: server resolves Git top-level, prefers normalized remote identity (`host/owner/repository`) and hashes it to 24 hex chars. Without a usable remote it hashes the canonical real path of Git `--git-common-dir`, so linked worktrees share a repository identity.
Storage: one protected `active-work-registry.json` under the workflow-state root with a cross-process sidecar-directory lock.
Records own repository ID/display, worktree root, branch/head, task-like title/scope, affected/risk areas, safe parallel work and next action.
Current strength: repository identity is already materially more stable across worktrees than workflow path-digest identity and is the leading candidate for B2 reuse.
Target ownership: Repository + Task coordination record.
Security role: coordination/enforcement precondition, not authorization; it must remain before approval-consuming policy preflight.

### Workflow progress and opportunistic scheduling

Current location: derived from the same single WorkflowState and stage dependency/evidence model.
Current identity: `workflowId` plus path-keyed workflow state.
Target ownership: Task/Run. Progress/ETA/scheduling engines remain RDC capabilities, but individual percentages, waits, blockers and ready stages belong to one task/run.
Security role: scheduling/evidence only; cannot authorize a side effect.

## Capability/data scope matrix

| Capability | Capability scope | Current state key | Target data scope |
| --- | --- | --- | --- |
| Policy / entitlement | RDC | account/install/device/resource | RDC/Device/Action |
| Approval engine | RDC | exact request/action fingerprint | Action |
| Audit | RDC | request/device/action metadata | Action + optional project/task correlation |
| Project workflow | RDC | projectRoot digest + workflowId | Project + Task/Run |
| Progress / scheduler | RDC | workflowId | Task/Run |
| Active Work Registry | RDC | stable repositoryId + worktree record | Repository + Task |
| Operational Memory | RDC | projectRoot digest + workflowId events | Project + Task/Run + safe Global RDC applicability |
| Graphify integration | RDC tooling | checkout/repository graph | Repository |

## B1/B2 design constraints discovered

1. Do not simply rename `workflowProjectDigest` to `projectId`: its input is a physical checkout path and therefore is not a stable multi-worktree/multi-device project identity.
2. Reuse or extract the proven Active Work remote/common-dir repository identity semantics instead of inventing a second repository fingerprint.
3. Project and Repository must remain separate concepts because one Project may contain multiple repositories.
4. `TaskId`, `RunId` and client-provided `ProjectId` are correlation/guidance identifiers until server association is independently verified; none may weaken policy or Active Work checks.
5. Existing v1 workflow/memory paths require a versioned migration/compatibility path rather than destructive in-place renaming.
6. SQLite M2 must wait for stable Project/Repository identity so its schema is not permanently keyed to legacy `workflowId`/path digest.

## B0 conclusion

The safest first production change is Operational Memory M1 only. It touches JSONL append/recovery mechanics but leaves all current identity and retrieval semantics unchanged. After M1 is integrated, B1/B2 should extract stable scope primitives and repository resolution in a separate RED->GREEN slice, then M2 can index events against those stable identities.
