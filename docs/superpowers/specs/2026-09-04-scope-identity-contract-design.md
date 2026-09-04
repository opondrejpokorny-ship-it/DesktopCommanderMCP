# Scope Identity Contract — B1/B2 Design

Date: 2026-09-04
Status: design only; no scope persistence migration in the M1 slice
Baseline inspected: authoritative `prototype/free-pro-team` at `6aa1eb7`

## Goal

Define durable identity primitives for the approved four-scope architecture without weakening security boundaries or creating a second repository identity system.

The lifecycle hierarchy is:

`RDC -> Project/Repository -> Task/Run -> Action`

`DeviceId` is an orthogonal correlation dimension, not a fifth lifecycle scope.

## Core rule

Capability scope and data scope are separate. Scope metadata can guide workflow, correlation, memory retrieval and UI, but must never grant ALLOW, bypass approval, bypass upstream validation or weaken Active Work enforcement.
## RepositoryId

Do not invent a new repository fingerprint. Active Work Registry already derives a 24-hex ID from a server-resolved identity:

- prefer normalized Git remote host/path when available;
- otherwise hash the canonical shared Git common directory;
- the local fallback therefore remains stable across worktrees of the same local repository.

B2 should extract this logic into a shared open-core repository-identity module and make Active Work consume that module unchanged. Characterization tests must prove existing Active Work IDs do not change.

A client-provided repository ID is never authoritative. The server resolves canonical path -> Git root -> repository identity.

## ProjectId

Project identity must be independent of checkout path and must not trust a repo/client supplied string as an isolation boundary.

For the first implementation, an unregistered single-repository project gets a deterministic server-derived ProjectId from RepositoryId. This gives stable isolation immediately without a new mutable registry.

Future multi-repository projects use a server-owned Project Registry binding one ProjectId to multiple RepositoryIds. Repo Project Profile metadata may request or display a project key, but cannot by itself create a trusted binding.
## TaskId and RunId

Current v1 workflow state has one server-generated `workflowId`. B4 migration must preserve compatibility rather than silently reinterpret historical files.

Recommended migration rule:

- migrated v1 `workflowId` becomes the initial stable TaskId;
- new TaskId is generated server-side when a new logical task is created;
- RunId is generated per concrete execution/resume run and is optional until B4 introduces run history;
- user/client metadata may refer to a task/run but cannot create authorization effects.

This lets `Task` outlive a restarted agent run while retaining a direct migration path from existing state.

## ActionId

Do not reuse approval IDs or `auditRequestId` as ActionId:

- approval record ID identifies an approval request;
- exact-action fingerprint identifies canonical tool+args for approval matching;
- `auditRequestId` exists only for audited Team actions.

A future universal ActionId should be generated server-side at the request/execution boundary, independently of tier and audit enablement. It is correlation metadata only and must not enter the approval fingerprint.
## ExecutionContext target

The internal context should be small and optional:

```ts
interface ExecutionContext {
  deviceId?: string;
  projectId?: string;
  repositoryId?: string;
  taskId?: string;
  runId?: string;
  actionId: string;
}
```

Repository/project values used for isolation are resolved server-side. Missing project context must not block ordinary non-project Desktop Commander operations.

## B2 first implementation boundary

After M1 is integrated and Registry is re-read, the first B1/B2 production slice should only:

1. extract repository identity into a shared module with characterization coverage;
2. add typed scope IDs and pure ProjectId derivation from RepositoryId;
3. expose a server-side resolver for path -> RepositoryId -> implicit ProjectId;
4. leave workflow persistence, approvals, policy decisions, audit schema and Operational Memory retrieval unchanged.

SQLite, Project Registry persistence, Task/Run migration and Action correlation are later slices. This keeps the first identity change behavior-preserving and independently reviewable.