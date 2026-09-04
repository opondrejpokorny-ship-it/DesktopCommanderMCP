# Workflow Finalization Gate Implementation Plan

**Goal:** Make external-wait finalization persistent and coordinator-enforced so merged work cannot be considered complete before exact merged-SHA CI, docs, and Registry cleanup.

**Architecture:** Recover the validated dependency-aware scheduler concepts from PR #12 onto current prototype `94e0ecf`, integrate them with current Operational Memory, and use explicit required profile stages plus dependency/evidence invariants as the finalization latch. No background service is added.

## Task 1 — Establish clean baseline

Files: no production changes.

1. Verify branch/worktree/remotes and exact prototype baseline.
2. Run `npm.cmd ci` if dependencies are not already installed.
3. Run build and existing project-workflow / operational-memory focused tests.
4. Run `git diff --check`.
5. Record baseline evidence in Work Log.

## Task 2 — RED: scheduler and finalization contract

Create focused tests for:
- `waiting_external` persistence and recommended re-check;
- dependency-aware readiness while an external wait exists;
- rejection of early downstream stage completion;
- `finish` rejection while a required wait or stale evidence exists;
- Git-HEAD-scoped post-merge evidence becoming stale after HEAD changes;
- legacy profile sequential compatibility;
- Operational Memory still present in status/resume.

Run the new tests before production changes and confirm failure for the intended missing-contract reason.

## Task 3 — GREEN: coordinator model

Modify `src/workflow/project-workflow.ts` minimally to:
- add `waiting_external` stage state;
- parse optional `dependsOn`, `workMode`, and `evidenceScope` profile fields;
- calculate evidence staleness from current Git HEAD;
- expose `readyStages`, `opportunisticStages`, `waitingStages`, and `recommendedStage`;
- enforce declared dependencies when recording completed/skipped stages;
- reject finish when required evidence is stale or a waiting stage remains;
- preserve current Operational Memory behavior and lesson ranking.

Modify `src/tools/project-workflow.ts` and `src/tools/schemas.ts` only as required for the new contract and clear status output.

## Task 4 — GREEN: project finalization profile

Modify `.desktop-commander/project-workflow.json` to add explicit required `post-merge-ci` and `registry-cleanup` stages, with finalization dependencies and Git-HEAD-scoped evidence where appropriate.

Update `skills/software-project-workflow/SKILL.md` plus packaging mirrors byte-identically. Update server guidance only if needed to ensure resume/status re-check semantics are visible to clients.

## Task 5 — Focused and real-MCP verification

Run build, new focused unit tests, existing coordinator tests, Operational Memory tests, skill-distribution/contract tests, and a real built-MCP integration that exercises merge-finalization wait → resume → completion ordering.

Negative coverage must prove waiting/stale/dependency violations do not complete the workflow and that authorization/policy behavior is unchanged.

## Task 6 — Broader regression and review

Run full `npm test`, build/typecheck/lint scripts that exist, packaging/composition/security regressions affected by workflow changes, and `git diff --check`. Reproduce any baseline/environment failures against clean authoritative prototype before classifying them as non-regressions.

Review the complete diff for unrelated changes, privacy regressions, authorization changes, stale PR #12 code accidentally copied wholesale, and workflow compatibility.

## Task 7 — PR / CI / integration

Commit and push the clean replacement branch. Open a PR against `prototype/free-pro-team`, explicitly superseding PR #12. Require current-base/expected-head protection and all applicable CI before merge. Close PR #12 as superseded only after the replacement PR exists and preserves its rationale/evidence.

Merge only into `prototype/free-pro-team`; never merge prototype into `main` without explicit user approval.

## Task 8 — Exact merged-SHA finalization

Verify the exact new prototype SHA and all intended post-merge workflows. Fast-forward the clean canonical checkout when safe and run intended post-merge local checks.

Update Engineering Playbook to record the persistent external-wait/finalization rule, update Work Log and Owner Presentation Highlights with verified evidence, then remove the coordinated scheduler/finalization Registry entry only after those completion conditions are met.

No deployment or live service restart is performed unless separately authorized by the user.
