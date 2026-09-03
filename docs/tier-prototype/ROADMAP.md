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
- Added nested-rule specificity tests.
- Added per-device folder rules.

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
- Handles common forms such as executable paths, `.exe`, environment prefixes, shell chains and command substitution.

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

Added `software-project-workflow` skill.

Lifecycle:

**Inspect → Plan → Implement → Test → Review → Document**

Operational memory covers:

- goal
- plan
- estimated progress
- changes
- failed attempts
- lessons
- verification
- final state
- resumable checkpoint

Privacy rules explicitly prohibit storing secrets.

The skill is mirrored for the supported plugin layout and protected by a contract test.

**Exit criteria: PASS.** A later agent/session receives a clear plan, work log and checkpoint model instead of rediscovering the project from scratch.

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

At the latest full verified SHA before this documentation update:

- Focused policy suite: **PASS**
- Real MCP policy integrations: **PASS**
- Full prototype test suite: **PASS**
- Clean upstream baseline test suite: **PASS**
- Standalone Control Center CI: **PASS**
- Local MCP build: **PASS**

## Deferred ideas

These remain product ideas, not first-prototype requirements:

- Server Builder / hosted workspace.
- Billing.
- Paid skills marketplace.
- Full private/self-hosted Remote MCP relay implementation.
- Enterprise SSO / centralized RBAC.
- Background autonomous workers.
