# Operational Memory M1 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Harden the existing append-only Operational Memory JSONL journal for cooperative cross-process writers and crash-truncated tails without changing memory retrieval scope or security semantics.

**Architecture:** Keep JSONL authoritative. Add a per-journal sidecar lock around the complete check-and-append critical section, retain the existing in-process promise chain, and append a separator LF rather than rewriting history when the previous process left a partial final record. SQLite and Project/Global retrieval remain out of scope.

**Tech Stack:** TypeScript/Node 24, node:fs/promises, existing project_workflow/Operational Memory APIs, JavaScript integration tests.

**Spec:** `docs/superpowers/specs/2026-09-04-scope-architecture-memory-foundation-design.md`

## Global Constraints

- Start from authoritative prototype `6aa1eb7ceff2ff4b12c8bc2e4ddc51c2cf0cc295`.
- Preserve policy/approval/upstream validation semantics and the Free/open-core composition boundary.
- JSONL remains append-only authority; do not add SQLite in M1.
- Do not add raw MCP args, terminal commands/output, file contents, credentials or approval payloads to persistence/locks.
- Keep current 512 KiB tail, 1000-event cap, current-workflow filter and 8-lesson model cap unchanged.
- M2/M3 expected RED tests must remain RED after M1.

---
### Task 1: B0 inventory + baseline

**Files:**
- Create: `docs/tier-prototype/SCOPE_ARCHITECTURE_INVENTORY.md`
- Read-only inspect: `src/workflow/workflow-storage.ts`, `src/workflow/project-workflow.ts`, `src/workflow/active-work-registry.ts`, `src/workflow/operational-memory.ts`

**Interfaces:**
- Consumes: current path-digest workflow storage and Active Work repository identity.
- Produces: reviewed ownership/identity inventory used by B1/B2 after M1 integration.

- [ ] Record current stores, key functions, lifetime, consumers, trust/security relevance and target scope.
- [ ] Run `npm.cmd run build` and `node test/test-operational-memory-scale-characterization.js`.
- [ ] Run `node test/characterization/operational-memory-scale-expected-red.js` and confirm it fails only for future project-history/index behavior.
- [ ] Commit inventory/baseline documentation.

### Task 2: Establish M1 RED

**Files:**
- Create: `test/test-operational-memory-storage-hardening.js`

**Interfaces:**
- Consumes: `recordOperationalLesson`, `resolveWorkflowMemoryPath`, `startProjectWorkflow` from built workflow API.
- Produces: deterministic regression contract for lock respect, stale-lock recovery and truncated-tail repair.

- [ ] Write a fixture that creates a git repo, workflow profile and isolated workflow-state root.
- [ ] Test that a fresh `<memoryPath>.lock` delays a writer until the lock is removed.
- [ ] Test that a stale `<memoryPath>.lock` is removed/recovered and does not remain after append.
- [ ] Test that a partial final JSON fragment without LF does not swallow the next valid event.
- [ ] Build and run only `test/test-operational-memory-storage-hardening.js`; verify the lock/truncated-tail assertions are RED for the expected missing behavior, not setup errors.
- [ ] Commit the RED test separately.

### Task 3: Minimal M1 GREEN

**Files:**
- Modify: `src/workflow/operational-memory.ts`
- Test: `test/test-operational-memory-storage-hardening.js`

**Interfaces:**
- Consumes: `resolveWorkflowMemoryPath(projectRoot)` and existing `memoryWriteChains` ordering.
- Produces: private cross-process lock + append routine; public Operational Memory APIs remain unchanged.

- [ ] Add bounded lock retry/stale constants and `delay` import.
- [ ] Implement a private lock helper using atomic sidecar directory creation and conservative stale-lock removal.
- [ ] Keep the whole last-byte check plus append inside the cross-process lock.
- [ ] Open the journal append/read capable; if non-empty and final byte is not LF, append exactly one LF before the new JSON event.
- [ ] Never truncate/rewrite an invalid prior fragment.
- [ ] Release the sidecar lock in `finally`, preserving the existing per-process promise chain.
- [ ] Run the focused hardening test to GREEN.
- [ ] Commit minimal production GREEN.

### Task 4: Cross-process proof

**Files:**
- Create: `test/fixtures/operational-memory-writer.js`
- Modify: `test/test-operational-memory-storage-hardening.js`

**Interfaces:**
- Child writer receives project root/state root/count/lesson code via argv/environment and uses only public built workflow APIs.
- Parent verifies complete JSONL records and event count after concurrent child completion.

- [ ] Add two simultaneous child writers targeting one active workflow journal.
- [ ] Assert every non-empty line is valid JSON and expected sanitized event count is present.
- [ ] Re-run focused test repeatedly to catch ordering/race regressions.
- [ ] Commit cross-process proof.

### Task 5: Verification and integration

**Files:**
- Modify if evidence changes: `docs/benchmarks/operational-memory-m0-baseline.md` only to add M1 compatibility evidence, never rewrite M0 measurements.

- [ ] Run build/typecheck.
- [ ] Run `test/test-operational-memory.js`, capture-hardening tests, restart/real-world Operational Memory integrations and the new storage hardening test.
- [ ] Run M0 scale characterization and confirm all four current-contract assertions remain GREEN.
- [ ] Run M2/M3 expected-RED file and confirm both future gaps remain RED.
- [ ] Run Free/open-core composition proof and broad prototype regression suite.
- [ ] Run `git diff --check` and review the complete diff for unrelated/security-sensitive changes.
- [ ] Synchronize with current authoritative prototype and upstream baseline; rerun exact-head focused checks.
- [ ] Push task branch, open PR against `prototype/free-pro-team`, require exact-head CI, integrate with expected-head protection, then verify exact merged SHA/post-merge CI.
- [ ] Update Work Log/Owner Highlights as appropriate and remove/advance the Active Work Registry entry.

## Self-review

The plan intentionally does not implement SQLite, scope IDs, Project Profile, project/global lesson retrieval, rotation, retention or Memory UI. Those remain later slices after M1 integration. All M1 production behavior is covered by pre-existing or newly established tests, and public MCP/workflow API signatures remain unchanged.