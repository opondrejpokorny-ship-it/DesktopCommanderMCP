---
name: software-project-workflow
version: 0.1.0
audience: agent
description: >-
  Run software work as a repeatable lifecycle with operational memory. Use when
  the user asks the agent to build, fix, refactor, migrate, deploy, audit, or
  continue a software project autonomously for more than a trivial one-step
  change. The workflow keeps a plan, estimated progress, an append-only work log,
  and a resumable checkpoint so later sessions can continue without rediscovering
  the same context or repeating failed attempts.
---

# Software Project Workflow

Use this skill for project work that has multiple steps, meaningful risk, or may
continue across sessions.

The default lifecycle is:

**Inspect → Plan → Implement → Test → Review → Document**

Do not treat "code written" as done. A task is complete only when the requested
behavior is verified and the operational memory reflects the final state.

## 1. Inspect

Before changing files:

1. Read the project's existing instructions and documentation.
2. Inspect the relevant code and configuration.
3. Check version-control state before writing.
4. Identify unrelated or pre-existing work and avoid overwriting it.
5. Establish a baseline for the behavior you are about to change.
6. For risky changes, prefer a read-only reproduction or RED test first.

The live project state is the source of truth. Existing documentation and the
previous checkpoint are context, not proof that the current system still matches
them.

## 2. Plan

Create a short plan before implementation.

The plan must state:

- goal,
- important constraints,
- definition of done,
- major lifecycle phases,
- expected verification,
- known risks,
- current estimated progress.

For longer work, report **estimated progress** as approximate work remaining or
completed across the whole lifecycle, not only coding.

Good:
- "About 60% complete. Implementation is done; integration tests, diff review,
  documentation, and live verification remain."

Bad:
- "90% complete" immediately after writing code when testing and deployment have
  not started.

Never use false precision. Update the estimate after meaningful milestones.

**100% is reserved for work whose requested behavior has passed verification and
whose required documentation is up to date.**

## 3. Operational memory files

When the user wants persistent project execution memory, create or reuse:

```
.desktop-commander/
  plan.md
  work-log.md
  checkpoint.md
```

If the project already has an established documentation location or naming
scheme, follow that instead of creating a competing system.

### plan.md

Keep the current execution plan concise.

Recommended structure:

```markdown
# Current plan

Goal:
Definition of done:
Constraints:

## Phases
- [x] Inspect
- [ ] Plan / RED baseline
- [ ] Implement
- [ ] Test
- [ ] Review
- [ ] Document
- [ ] Live verification

Estimated progress:
Risks:
```

Update this file when the plan materially changes, not after every tool call.

### work-log.md

This is the project's **automatic execution / operational memory**.

Append meaningful events. Do not rewrite history to make the work look cleaner
than it was.

Each entry should capture only useful information such as:

```markdown
## 2026-09-03 — <short milestone>

Goal:
What changed:
Why:
Failed attempts:
Lessons:
Verification:
Remaining:
```

Record failed attempts when they teach something another session should not have
to rediscover.

Do not log trivial shell noise, every file read, or every successful command.
The log should remain useful to a future agent.

### checkpoint.md

This is the small, overwriteable resume file.

Rewrite it after meaningful milestones, before a long/risky operation, and when
work stops before completion.

Recommended structure:

```markdown
# Resume checkpoint

Goal:
Current branch / workspace:
Current estimated progress:

## Completed
-

## Remaining
-

## Files changed
-

## Running processes
-

## Latest verification
-

## Known problems
-

## Failed attempts / lessons
-

## Next exact action
-
```

A checkpoint is a recovery aid, not a claim that the recorded state is still
true.

## 4. Implement

Make the smallest coherent change that advances the plan.

Prefer:

- one clear responsibility per change,
- existing project conventions,
- additive safety layers instead of bypassing existing guardrails,
- explicit validation at trust boundaries,
- reversible changes,
- focused commits when version control is part of the workflow.

Do not mix unrelated cleanup into the same change unless it is required for the
task.

For behavior with meaningful failure risk, use RED → GREEN when practical:

1. Write or identify a test that fails for the missing behavior.
2. Confirm the failure is for the expected reason.
3. Implement the change.
4. Confirm the test turns GREEN.
5. Keep the regression test.

## 5. Test

Verification should match the risk.

Use the smallest fast test first, then broaden:

1. focused unit / contract test,
2. integration test,
3. broader project suite,
4. build / typecheck / lint where applicable,
5. live or deployed smoke test when the task changes runtime behavior.

For side-effecting features, verify the side effect itself.

Example:
If a policy is supposed to block a file write, do not only assert that the
function returned "blocked". Re-read the file and prove it did not change.

Separate:
- product/code failures,
- test failures,
- environment or CI infrastructure failures.

Do not "fix" product code to compensate for an unrelated broken runner.

## 6. Review

Before declaring completion:

- review the diff,
- check for unrelated changes,
- inspect security/privacy implications,
- check error paths and fail-open behavior,
- verify sensitive data is not written to logs or operational memory,
- check portability when the project is cross-platform,
- compare final behavior with the definition of done.

If a rule or permission model overlaps, test precedence explicitly. Security
should not depend on edit order unless that behavior is deliberate and
documented.

## 7. Document

Update durable documentation with:

- what changed,
- why it changed,
- how it was implemented,
- verification performed,
- security or product boundaries,
- remaining limitations,
- next planned work.

This is different from ordinary knowledge-base documentation.

Knowledge management explains the project or result.

**Operational memory records how the work was executed**, including useful failed
attempts, lessons, current progress, verification, and the resume point.

## 8. Resume

When continuing previous work:

1. Read `checkpoint.md` first.
2. Read only the relevant recent part of `work-log.md`.
3. Re-check Git status / branch / files / running processes.
4. Re-run the last important verification if state may have changed.
5. Compare reality with the checkpoint.
6. Update the checkpoint if it is stale.
7. Continue from **Next exact action**.

Never blindly execute a command copied from an old checkpoint.

## 9. Checkpoint cadence

Create or refresh a checkpoint:

- after a meaningful phase becomes GREEN,
- before deploy / migration / destructive or difficult-to-reverse work,
- before switching machines or environments,
- when context is getting long,
- when stopping with work incomplete,
- immediately after discovering an important failure mode or workaround.

Do not checkpoint every minor edit.

## 10. Progress reporting

For longer autonomous work, give the user short progress updates.

Useful updates include:

- approximate percent remaining,
- a finding that changes the plan,
- RED becoming GREEN,
- a newly discovered risk,
- the current blocker,
- the next major phase.

Base progress on the full plan.

A suggested mental model:

- Inspect / baseline: 10–20%
- Plan / RED coverage: 10–15%
- Implementation: 25–40%
- Verification: 20–30%
- Review / docs / live check: 15–25%

Adjust for the actual task.

## 11. Privacy and safety

**Never store secrets** in `plan.md`, `work-log.md`, or `checkpoint.md`.

Do not persist:

- passwords,
- API keys,
- access or refresh tokens,
- cookies,
- private keys,
- raw command output that contains credentials,
- full sensitive file contents merely for convenience.

Record a safe description instead, for example:

- "OAuth token refresh failed" rather than the token,
- "write to production config blocked" rather than the secret config contents.

When an exact command contains credentials, redact them before documenting it.

## 12. Definition of done

Before marking the task complete, confirm as applicable:

- requested behavior works,
- relevant RED tests are GREEN,
- integration or live verification passed,
- no unintended side effects were found,
- diff was reviewed,
- operational memory is current,
- checkpoint reflects the final state or is removed/marked complete,
- required durable documentation is updated.

Only then report 100%.
