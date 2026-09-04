# Scope Architecture + Operational Memory Foundation Design

Date: 2026-09-04
Status: approved design direction; first implementation slice M1
Baseline: `prototype/free-pro-team` @ `6aa1eb7ceff2ff4b12c8bc2e4ddc51c2cf0cc295`

## Goal

Separate Desktop Commander capabilities from the lifetime and ownership of their state while scaling Operational Memory without weakening policy, approvals, upstream validation, privacy, or resumability.

The target ownership hierarchy is:

`RDC -> Project/Repository -> Task/Run -> Action`

Device identity is orthogonal context and may correlate with any level.

The key rule is: **capability scope is not data scope**. Policy, workflow, memory, progress and Active Work remain reusable RDC capabilities, while their records are explicitly tied to project/task/action identities where appropriate.

## Security and authority boundaries

Project/task context is guidance and correlation only. It can never grant authorization, mint entitlement, bypass Active Work enforcement, consume/skip approval, or bypass existing Desktop Commander validation.

Execution ordering remains:
`core safety -> scope resolution -> Active Work coordination -> commercial policy -> upstream validation/handler -> execution -> audit`.

Operational Memory remains advisory-only. No lesson, scope tag, SQLite index row, Project Profile field or client-provided identifier may produce `ALLOW`, suppress `DENY`, or satisfy `REQUIRE_APPROVAL`.
## Stable identity direction

The scope foundation will introduce stable internal concepts for `ProjectId`, `RepositoryId`, `TaskId`, `RunId` and `ActionId`. These identities must not be treated as trusted merely because a client supplied them.

Repository association must be derived or verified server-side from canonical filesystem/Git facts. A project may own multiple repositories, and a repository may have multiple worktrees. Filesystem path alone is therefore not the long-term project identity.

Existing Active Work repository identity is the first implementation source to evaluate for reuse. Scope B0/B1/B2 must characterize it before any new persistence schema is committed.

## Operational Memory storage model

JSONL remains the durable append-only journal and recovery authority. SQLite is planned later as a rebuildable derived index; it is not part of M1 and must never become the only source of a lesson's scope or promotion decision.

Memory applicability has three values layered over the ownership model:
- `workflow`: usable only for the current Task/Run workflow context;
- `project`: usable by later tasks in the same verified project;
- `global_rdc`: usable across projects only for server-whitelisted safe lesson codes or an explicit future trusted human promotion.

Correlation metadata such as device/project/repository/task/run/action/tool/stage is not itself an authorization scope.

Model context remains bounded. A larger durable history or index must not imply a larger prompt; the current maximum of 8 returned lessons remains the compatibility baseline until an explicit later product change.
## M0 evidence carried forward

Merged M0 characterization proves the current reader:
- reads at most the final 512 KiB of the project JSONL journal;
- considers at most 1000 parsed events for the active `workflowId`;
- groups by server-reconstructed fingerprint;
- returns at most 8 lessons;
- can lose an older valuable lesson once it falls outside the hot tail;
- does not normally reuse a same-project lesson after a new workflow ID is created.

The 1,000,000-event synthetic journal was about 224.9 MB while status retrieval remained bounded. The first scale problem is therefore durable history/retrieval semantics and journal growth, not a full-history scan on each resume.

## M1 first implementation slice

M1 changes only JSONL write/recovery behavior. It does not add SQLite, Project/Global retrieval, new scope identifiers, or UI.

Required behavior:
1. serialize cooperative writers across Node processes for one memory journal;
2. retain the existing in-process write chain so call order remains deterministic within one process;
3. use a sidecar lock under the protected workflow-state root and recover stale/orphaned lock state conservatively;
4. perform the trailing-line check and append while holding the same cross-process lock;
5. if a crash left a non-empty journal without a final LF, append only a separator LF before the next valid event; never rewrite or truncate historical bytes;
6. keep malformed historical records non-authoritative: the reader validates/ignores them and later valid records remain readable;
7. preserve privacy: lock metadata contains no MCP args, paths beyond the already-derived memory path, commands, file contents, credentials or approval payloads.
## B0/B1/B2 boundary during M1

Scope B0 inventory runs in parallel with M1 and records current identity/storage owners. B1/B2 implementation waits until M1 is integrated and the branch is refreshed from the authoritative prototype.

The first scope implementation after M1 will define primitives and Project/Repository identity without changing policy or approval semantics. SQLite M2 waits until those identities are stable so the index is not built around the legacy `workflowId` key and immediately migrated again.

## Verification gates

M1 must establish RED before production changes for:
- a truncated final JSONL fragment swallowing the next valid event;
- a second cooperative process ignoring an active journal lock;
- stale/crash lock recovery where the writer can safely continue.

GREEN must include focused Operational Memory tests, M0 characterization, the future expected-RED file remaining RED for M2/M3-only behavior, build/typecheck, relevant real built-MCP restart/status coverage, broad prototype regression tests and `git diff --check`.

Security/privacy regression checks must prove no raw command, raw MCP arguments, file contents, credential markers or approval payloads are introduced by the new storage coordination.

## Later dependency order

After M1 integration: B1/B2 scope primitives and Project/Repository identity -> M2 rebuildable SQLite index -> B3/B4 Project Profile and Task/Run workflow binding -> M3 workflow/project/global retrieval -> later rotation, retention and read-only Memory UI.

No deployment is part of this foundation slice unless separately authorized.