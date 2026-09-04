# Workflow Finalization Gate Design

Date: 2026-09-04
Status: User-approved design
Target: `prototype/free-pro-team`
Baseline: `94e0ecfcac3e4b94cb2be5aaec96e3a59251b835`

## Problem

The Engineering Playbook requires exact merged-SHA verification, post-merge CI, durable docs, and Active Work Registry cleanup before completion. The native `project_workflow` profile does not currently model post-merge CI or Registry cleanup as explicit required stages.

This created a real sequencing gap: a task could merge, record that CI was still running, and then have no persistent native obligation that forced a later session to return after CI completed and finish docs/Registry cleanup.

The previous incident was not a Registry persistence failure. Cleanup was correctly ineligible while the last merged-SHA CI was running; the missing behavior was a durable finalization gate and re-check contract.

## Design

Recover the existing opportunistic-scheduling design on the current authoritative prototype instead of creating a second scheduler or a background worker.

The coordinator will support `waiting_external` separately from a true `blocked` stage, stage dependencies, dependency-aware ready stages, conservative read-only opportunistic recommendations, and Git-HEAD-scoped evidence staleness.

The project workflow profile will explicitly require:

`prototype-integration → verify-prototype-sha → post-merge-ci → docs-sync → registry-cleanup → final-report`.

## Enforcement semantics

- `finish` must reject any required stage that is incomplete, `waiting_external`, or backed by stale required evidence.
- Completing or skipping a stage must not jump over unsatisfied declared dependencies. This makes the finalization order a coordinator invariant, not only guidance.
- `post-merge-ci` evidence is scoped to the current Git HEAD. If HEAD changes, the evidence becomes stale and the stage becomes actionable again before downstream finalization can be trusted.
- `registry-cleanup` is required and depends on completed post-merge CI and docs sync. It cannot be completed early.
- Existing profiles without explicit dependencies preserve their sequential readiness behavior.
- A waiting stage remains persisted across `status`/`resume`. If no safe already-planned read-only work is ready, it is the recommended work to re-check.

## No background-worker claim

Desktop Commander does not autonomously wake a completed ChatGPT turn. The durable guarantee is persistence: if a session stops while CI is running, the next `status` or `resume` restores the unfinished finalization state and directs the agent back to the external dependency before completion.

## Security and privacy

Workflow state remains orchestration only. It never authorizes tool execution or bypasses commercial policy, approvals, allowed-directory enforcement, blocked-command validation, command validation, or upstream handler safeguards.

No new raw command, file-content, approval-payload, MCP-argument, or credential persistence is introduced. Existing Operational Memory privacy protections must remain intact.

## Recovery strategy

The old `C:\DesktopCommanderOpportunisticScheduling` worktree is preserved untouched because it contains unresolved merge conflicts. PR #12 and its branch are prior evidence only. A clean replacement branch is rebuilt on the current authoritative prototype and may selectively port validated scheduler behavior without copying stale conflicting source wholesale.
