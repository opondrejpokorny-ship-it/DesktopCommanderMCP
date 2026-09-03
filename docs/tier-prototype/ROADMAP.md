# Free / Pro / Team Prototype Roadmap

## Principle

Build one convincing end-to-end workflow before expanding scope.

Do not build the Server Builder, billing, marketplace, or a replacement hosted Remote MCP backend in the first version.

## Phase 0 — Baseline and audit

Status: in progress

- Verify upstream repository and license.
- Keep fork `main` synchronized with upstream.
- Create isolated prototype branch.
- Map MCP request dispatch.
- Map filesystem restrictions.
- Map command restrictions.
- Review relevant regression tests.
- Record known security limitations.

Exit criteria: architecture document identifies the policy interception point and preserves upstream guardrails.

## Phase 1 — Policy model

- Add tier configuration: free / pro / team.
- Define normalized actions and resources.
- Define allow / deny / require_approval result.
- Add built-in policy profiles:
  - Full Access
  - Safe Developer
  - Read Only
- Add unit tests before wiring policy decisions into execution.

Exit criteria: deterministic policy evaluation with RED -> GREEN tests.

## Phase 2 — Filesystem vertical slice

- Intercept `write_file`.
- Add folder policies:
  - read/write
  - read-only
  - blocked
  - write requires approval
- Preserve existing `validatePath()` checks.
- Add regression tests for path boundaries and symlinks.

Exit criteria: protected write is prevented before execution and an allowed write behaves exactly like upstream.

## Phase 3 — Approval engine

- Pending approval store.
- One-time approval IDs.
- Expiration.
- Approve / deny.
- Bind approval to exact action + resource + arguments fingerprint.
- Explicit approved-action execution path.

Exit criteria: request -> approve -> execute works end-to-end without broad reusable approval tokens.

## Phase 4 — Audit log

- Log policy decision.
- Log approval decision.
- Log final execution result.
- Avoid file content / secrets in logs.
- Add query / pagination support.

Exit criteria: demo produces a readable chronological audit trail.

## Phase 5 — Terminal policies

- Preflight `start_process`.
- Keep upstream `blockedCommands` validation.
- Add allow / deny / approval rules by normalized command category.
- Add bypass-focused tests.

Exit criteria: policy layer adds control without weakening existing blocklist behavior.

## Phase 6 — Control Center

Separate repository when repository creation access is available.

Minimum UI:

- Devices
- Policy profiles
- Folder permissions
- Command permissions
- Pending approvals
- Audit log
- Current tier

Exit criteria: user can configure the first vertical slice without editing JSON manually.

## Phase 7 — Team multi-device prototype

- Device profile model.
- Different policy per device.
- Shared approval view.
- Cross-device audit.
- Reuse public remote-device interfaces where appropriate.
- Do not reproduce the proprietary hosted service.

Exit criteria: two device profiles can demonstrably enforce different policies.

## Phase 8 — Workflow skill + operational memory

Add one strong skill only:

Software Project Workflow:
check current state -> make a plan -> make changes -> test -> check result -> save what happened.

Operational memory fields:

- goal
- plan
- current progress
- changes
- failed attempts
- lessons
- verification
- final state
- checkpoint

Exit criteria: a later session can understand what happened without rediscovering the whole task.

## Phase 9 — Portfolio polish

- Clear README explaining why the prototype exists.
- Explicit attribution to Desktop Commander and MIT license.
- Explain what is upstream vs. prototype work.
- Security limitations section.
- Free / Pro / Team comparison.
- Architecture diagram.
- 60-90 second demo:
  1. AI attempts protected write.
  2. Approval appears.
  3. User approves.
  4. Write succeeds.
  5. Audit log records it.

## Deferred ideas

These are valuable but should not dilute the first prototype:

- Server Builder / hosted workspace.
- Paid skills marketplace.
- Billing.
- Self-hosted private Remote MCP relay implementation.
- Enterprise SSO / RBAC.
- Background autonomous workers.
