[Reading 279 lines from start (total: 279 lines, 0 remaining)]

# Free / Pro / Team Prototype Roadmap

## Principle

Build one convincing end-to-end workflow before expanding scope.

Do not build the Server Builder, billing, marketplace, or a replacement hosted Remote MCP backend in the first version.

## Phase 0 — Baseline and architecture audit

**Status: DONE**

- Verified upstream repository and MIT license.
- Kept fork `main` as a clean upstream mirror.
- Created isolated `prototype/free-pro-team` branch.
- Mapped central MCP request dispatch.
- Audited filesystem and command guardrails.
- Reviewed relevant upstream security/regression tests.
- Recorded security boundaries and known limitations.
- Added isolated prototype CI plus clean upstream baseline comparison.

**Exit criteria: PASS.** The policy interception point is defined and existing Desktop Commander guardrails remain in the execution path.

## Phase 1 — Policy model

**Status: DONE**

- Added tiers: Free / Pro / Team.
- Added normalized policy actions and resources.
- Added `allow / deny / require_approval`.
- Added profiles:
  - Full Access
  - Safe Developer
  - Read Only
- Added deterministic policy tests.
- Added device-specific rule support.

**Exit criteria: PASS.** Focused RED → GREEN policy tests are green.

## Phase 2 — Filesystem vertical slice

**Status: DONE**

- Intercepted real `write_file` execution before side effects.
- Added folder permissions:
  - read/write
  - read-only
  - blocked
  - write requires approval
  - inherit profile default
- Preserved existing Desktop Commander filesystem/path validation.
- Added path-boundary and normalization tests.
- Added canonical filesystem policy evaluation so symlink/junction aliases are matched against their real target.
- Added nested-rule specificity tests, including blocked-sibling junction escape coverage.
- Added per-device folder rules.
- Documented that folder rules are scoped rules rather than an implicit default-deny allowlist.

**Exit criteria: PASS.** A protected real MCP write is stopped before the file changes; an allowed/approved write behaves like upstream.

## Phase 3 — Approval engine

**Status: DONE (prototype scope)**

- Pending approval store.
- One-time approval IDs.
- Expiration.
- Approve / deny.
- Exact action fingerprint.
- Approval bound to the matching rule when applicable.
- One-time consumption.
- Human-only approval CLI outside the MCP tool surface.
- No raw file content or complete MCP arguments persisted.

**Exit criteria: PASS.** Request → block → human approve → exact retry → execute → consume is verified end-to-end.

## Phase 4 — Team audit

**Status: DONE (prototype scope)**

- Policy decision events.
- Approval decision events.
- Execution result events.
- Device metadata.
- Safe resource metadata.
- Duration/outcome.
- No raw terminal command text.
- No raw file contents.

**Exit criteria: PASS.** The live demo produces a chronological lifecycle from policy decision through approval to execution result.

## Phase 5 — Terminal policies

**Status: DONE (prototype scope)**

- `start_process` maps to `terminal.execute`.
- Existing Desktop Commander `blockedCommands` checks remain in place.
- Added managed command rules:
  - allow
  - require approval
  - block
  - inherit
- Added per-device command rules.
- Added token-aware command matching and bypass-focused tests.
- Handles common forms such as executable paths, `.exe`, environment prefixes, shell chains, command substitution, and common shell wrappers (`cmd`, PowerShell/pwsh, bash/sh/zsh/dash).
- `Read Only` is enforced as a hard ceiling even when more-specific explicit allow rules exist.
- Side-effecting meta-tools are policy-mapped: workflow mutations, search termination, and browser-opening feedback no longer slip through `Read Only` as unmapped calls.
- Command rules remain guardrails rather than a complete shell/OS sandbox; `Full Access` with arbitrary terminal execution is documented accordingly.

**Exit criteria: PASS.** Command governance is additive and does not replace upstream command validation.

## Phase 6 — Standalone Control Center

**Status: DONE (MVP)**

Repository:

`opondrejpokorny-ship-it/desktop-commander-control-center`

Features:

- Free / Pro / Team selector.
- Policy profile selector.
- Detected / selected device identity.
- Folder permission editor.
- Command permission editor.
- All-devices / this-device scope.
- Pending approvals.
- Approve once / deny.
- Team audit.
- Local-only security controls.

Architecture:

- Control Center is a human control surface.
- The MCP fork remains the enforcement source of truth.
- Policy/approval mutations are delegated to a human-only local CLI.
- AI does not receive an MCP tool that can approve its own request.

**Exit criteria: PASS.** Users can configure the core prototype without editing JSON.

## Phase 7 — Team multi-device

**Status: CORE MODEL DONE / OPTIONAL PHYSICAL TWO-DEVICE DEMO REMAINS**

Implemented:

- Device identity discovery without exposing Remote Device auth tokens.
- Device-scoped folder rules.
- Device-scoped command rules.
- Global-vs-device-specific rule scope.
- Device-specific precedence.
- Device metadata in audit.

Verified on the real primary Remote Device.

Optional remaining showcase work:

- Repeat the same policy demo across two simultaneously connected physical devices.

**Exit criteria for prototype architecture: PASS.**
**Optional portfolio enhancement:** two-machine visual demo.

## Phase 8 — Software Project Workflow + operational memory

**Status: DONE**

Added `software-project-workflow` skill plus a persistent runtime coordinator.

Lifecycle guidance:

**Inspect → Plan → Implement → Test → Review → Document**

Runtime:

- versioned per-project `.desktop-commander/project-workflow.json` profile
- `project_workflow` MCP tool with `start / status / resume / record / finish`
- local Git preflight and refreshed Git evidence
- whole-lifecycle progress and next-stage reporting
- persistent task state outside the repository
- profile fingerprint/drift protection before completion
- required-stage completion checks
- provider/agent evidence references with bounded summaries and credential redaction
- server initialization guidance encouraging automatic start/resume on material software work

Security/privacy:

- existing policy and upstream validation remain authoritative
- ordinary filesystem write/move/delete cannot modify workflow profile/state, including through symlink aliases
- agent-controlled MCP evidence cannot mint `user_authorization`
- authorization-required stages need a future trusted host/control-plane signal after explicit user authorization
- no raw file contents or raw terminal command output are persisted in workflow state
- the coordinator is operational control, not an OS security sandbox

Native lifecycle progress reporting is tier-aware through the real MCP tool
`report_task_progress`:

- Free → approximate percent remaining,
- Pro / Team → approximate percent remaining + estimated time remaining.

The estimate is intentionally rounded and described as approximate, never as a
deadline or guarantee. The tool reads the actual configured policy tier
server-side, so Free output strips ETA even if an agent supplies one. Progress
arguments contain only percentage, a short phase label, and the numeric time
estimate; file contents and raw terminal commands are not needed.

The progress reporter is protected by contract tests plus a real MCP stdio test
for `tools/list` and `tools/call`.

The skill is byte-identical across root, Claude and Cursor packaging and protected by distribution/contract tests.

Verification includes focused coordinator/security tests and a real built MCP stdio test proving instructions, tools/list registration, start→record→finish, filesystem tamper blocking, profile integrity and authorization rejection.

**Exit criteria: PASS.** A later agent/session can resume from persistent verified lifecycle state instead of relying only on prose guidance or rediscovering the project from scratch.

## Phase 9 — Portfolio polish

**Status: IN PROGRESS**

Done:

- Architecture documentation.
- Policy examples.
- Control Center documentation.
- Standalone Control Center README.
- Standalone local integration contract.
- Short demo script.
- Real cross-repository E2E proof.
- Clean upstream-vs-prototype CI baseline.

Remaining:

- Concise enforcement-repo showcase document.
- Final diff review.
- Optional draft PR as a shareable diff (do not merge to clean `main`).
- Optional screenshots/video.
- Final Drive work-log sync.

## Verified cross-repository proof

A real local E2E test on the primary Remote Device verified:

1. Standalone Control Center selected Team.
2. It used the real Remote Device identity.
3. A device-scoped folder was configured as approval-required.
4. A real MCP `write_file` request was blocked.
5. The file on disk remained unchanged.
6. The approval appeared in the standalone Control Center.
7. A human approval was issued through the standalone UI/CLI boundary.
8. The exact MCP retry succeeded.
9. The approval was consumed.
10. Team audit recorded the lifecycle.
11. Raw file content was absent from approval and audit stores.

## Current verification

For the project-workflow coordinator change on the merged task branch:

- Local MCP build / TypeScript: **PASS**
- Focused project-workflow coordinator tests: **PASS**
- Workflow skill contract + root/Claude/Cursor distribution: **PASS**
- Policy/control-plane focused regression tests: **PASS**
- Real built MCP project-workflow stdio integration: **PASS**
- Server/manifest tool registration via official MCP SDK: **PASS (27/27 tools)**
- Broad unit runner: **65/66 PASS**; the only failure is `test-enhanced-repl.js` because Python is unavailable in PATH, reproduced unchanged on pre-task baseline `2aab8cb`
- Broad integration runner exposed pre-existing fuzzy edit-block and terminal-approval test failures; both were reproduced unchanged on exact pre-task baseline `2aab8cb`
- `git diff --check`: **PASS**

These baseline/environment failures are tracked separately and are not attributed to the workflow coordinator change.

## Deferred ideas

These remain product ideas, not first-prototype requirements:

- Server Builder / hosted workspace.
- Billing.
- Paid skills marketplace.
- Full private/self-hosted Remote MCP relay implementation.
- Enterprise SSO / centralized RBAC.
- Background autonomous workers.

[executed on device: WIN-A0OFGC4ORFI (998ddf48-83cd-4223-bfeb-7ac96a8f7a93)]