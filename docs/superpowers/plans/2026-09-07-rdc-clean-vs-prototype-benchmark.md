# RDC Clean vs Prototype A/B Benchmark Harness Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build and safely install an exact-SHA A/B runtime harness that can switch the live Remote Desktop Commander between clean upstream and `prototype/free-pro-team`, with prototype restored as the default.

**Architecture:** Cross-platform Node helpers own manifest validation, exact-SHA/build verification, atomic variant selection, fixture reset, and privacy-safe metadata. Thin Windows PowerShell scripts own host provisioning, watcher/launcher installation, and supervision; they call the validated Node contract before launching. Remote auth remains shared in the real user profile; prototype-only commercial/workflow state gets isolated paths.

**Tech Stack:** Node.js 22+, ESM, PowerShell 5.1+, Git, npm, existing Desktop Commander remote mode.

**Spec:** `docs/superpowers/specs/2026-09-07-rdc-clean-vs-prototype-benchmark-design.md`

## Global Constraints
- Authoritative integration target is `prototype/free-pro-team`; never merge prototype work into `main`.
- Never branch-switch or destructively reset `C:\DesktopCommanderTierPrototype`.
- Clean and prototype SHAs are explicit and immutable in the manifest.
- Never duplicate the remote-device refresh-token store.
- Never log secrets, raw MCP args, file contents, approval payloads, or raw terminal commands.
- Switches fail closed; no silent fallback from one variant to the other.
- Live restart uses Remote Desktop Commander's graceful shutdown path; no forced kill of the RDC node process.
- Final installed/default state is prototype selected and prototype running.

---
### Task 1: Core manifest and exact-SHA contract

**Files:**
- Create: `scripts/benchmark/rdc-ab/lib.mjs`
- Create: `test/test-rdc-ab-harness.js`

**Interfaces:**
- Produces `validateManifest(manifest)`, `verifyVariant(manifest, variant)`, `selectVariant(root, variant)`, `readActiveVariant(root)`, `resetFixture(root, fixtureId, runId)`, and `safeRunMetadata(input)`.

- [ ] **Step 1:** Add a failing unit test for manifest schema/variant validation; run `node test/test-rdc-ab-harness.js` and confirm failure because `lib.mjs` is absent.
- [ ] **Step 2:** Implement only manifest validation and re-run until GREEN.
- [ ] **Step 3:** Add a failing exact-SHA test using temporary local Git repositories, including SHA mismatch and missing build entrypoint; verify RED.
- [ ] **Step 4:** Implement `verifyVariant` with `git rev-parse HEAD`, detached/branch-agnostic SHA equality, root containment, and `dist/index.js` existence; verify GREEN.
- [ ] **Step 5:** Add failing atomic-selection tests proving invalid variants/SHA mismatches do not modify `active-variant.txt`; verify RED.
- [ ] **Step 6:** Implement atomic temp-file + rename selection and readback; verify GREEN.
- [ ] **Step 7:** Add failing fixture-containment/reset and metadata-redaction tests; implement the minimum safe reset/copy and allowlisted metadata serializer; verify GREEN.
- [ ] **Step 8:** Run the focused test twice and `git diff --check`.

### Task 2: CLI and host provisioning

**Files:**
- Create: `scripts/benchmark/rdc-ab/cli.mjs`
- Create: `scripts/benchmark/rdc-ab/Setup-RdcAb.ps1`
- Extend: `test/test-rdc-ab-harness.js`

**Interfaces:**
- `cli.mjs` exposes `verify`, `select`, `status`, `reset-fixture`, and `init-manifest` commands.
- `Setup-RdcAb.ps1` consumes explicit `PrototypeSha`, `CleanSha`, source URLs, and `BenchmarkRoot`; it creates independent repos/builds and initializes prototype as active.

- [ ] **Step 1:** Add failing CLI tests for unknown command, invalid manifest, and machine-readable status; verify RED.
- [ ] **Step 2:** Implement CLI dispatch on top of `lib.mjs`; verify GREEN.
- [ ] **Step 3:** Add a Windows-only failing provisioning contract test using temporary local remotes and a no-install fixture mode; verify RED on Windows while non-Windows reports a deliberate SKIP.
- [ ] **Step 4:** Implement provisioning so partial failure never touches the live launcher, validates both exact SHAs, runs identical install/build commands, records build SHA-256, creates isolated prototype state directories, and writes the manifest atomically.
- [ ] **Step 5:** Run the Windows provisioning contract test and focused Node suite GREEN.
- [ ] **Step 6:** Provision `C:\RDC-Benchmark` using prototype `c4ffe5641310c9fc8fa00d3b99a6096ed39bf839`, clean same-base upstream `b240462839c194d2786b5dd1aa6c791f22eb8234`, and record observed latest upstream `1316c6c6a6d0bd484d68faa43869d76c7aa67ca5`.
- [ ] **Step 7:** Independently verify both repo HEADs, clean Git status, `dist/index.js`, package version, and build digest.

### Task 3: Stable supervisor and launcher install/rollback

**Files:**
- Create: `scripts/benchmark/rdc-ab/Run-RdcAbSupervisor.ps1`
- Create: `scripts/benchmark/rdc-ab/Install-RdcAbLauncher.ps1`
- Create: `scripts/benchmark/rdc-ab/Restore-RdcAbLauncher.ps1`
- Extend: `test/test-rdc-ab-harness.js`

**Interfaces:**
- Supervisor launches only the selected, verified variant and injects prototype state-path overrides only for prototype.
- Installer preserves the first exact launcher backup and replaces the launcher with a delegator only after validation.
- Activation validates the installed delegator, retires exactly one matching old watcher without killing its child, and starts the supervisor wrapper.
- Restore requires a verified prototype selection and restores the byte-preserved original launcher.

- [ ] **Step 1:** Add Windows-only failing installer tests against a temporary fake launcher: backup once, do not overwrite backup, refuse missing benchmark manifest, and emit a delegator containing no variant-specific repo path; verify RED.
- [ ] **Step 2:** Implement installer minimum GREEN without process manipulation; re-run tests.
- [ ] **Step 3:** Add failing supervisor `-ValidateOnly` tests for valid prototype, valid clean, SHA mismatch, missing entrypoint, and unknown active variant; verify RED.
- [ ] **Step 4:** Implement validation and environment construction; clean must not receive prototype policy/approval/audit/workflow overrides.
- [ ] **Step 5:** Add process-lifecycle behavior: wait while an existing known RDC remote process is alive, launch only after it exits, log only allowlisted metadata, and use bounded retry without variant fallback.
- [ ] **Step 6:** Implement rollback validation and temporary-path tests; re-run focused tests GREEN.
- [ ] **Step 7:** Add deterministic cross-process RED coverage, hold a host-wide identity-scoped mutex for each non-validation supervisor lifetime, and re-check known remote processes immediately before launch.
- [ ] **Step 8:** Add deterministic watcher-handoff RED coverage and implement separate fail-closed activation; prove the old child survives watcher retirement and cannot be respawned by that watcher.

### Task 4: Verification, integration, and safe live smoke

**Files:**
- Modify only the files created by Tasks 1–3 plus documentation evidence if needed.

- [ ] **Step 1:** Run focused benchmark-harness tests, project build, full `npm test`, applicable real MCP integrations, and `git diff --check`.
- [ ] **Step 2:** Run a read-only Codex review of the exact diff for process-race, path-containment, auth/session, privacy, and rollback edge cases; independently reproduce any material finding before fixing via RED→GREEN.
- [ ] **Step 3:** Review the full diff and confirm no `src/policy`, approvals, Operational Memory, Control Center, or remote transport production behavior changed.
- [ ] **Step 4:** Commit and push the task branch; open a PR targeting `prototype/free-pro-team`; inspect all CI and require GREEN for the exact PR head.
- [ ] **Step 5:** Re-fetch authoritative prototype. If it moved, merge current prototype into the task branch without rebase/stash/reset, rerun focused + broad gates, then update the PR.
- [ ] **Step 6:** Merge with expected-head protection, verify exact merged prototype SHA and post-merge CI, and safely fast-forward canonical `C:\DesktopCommanderTierPrototype` when clean/practical.
- [ ] **Step 7:** Re-read Registry, install only the benchmark host tooling with active variant `prototype`, preserve the original launcher backup, and stop only the identified old watcher wrapper if necessary.
- [ ] **Step 8:** Gracefully shut down RDC, verify supervisor reconnects to the pinned prototype, then select clean, gracefully shut down, and verify clean exact SHA/build.
- [ ] **Step 9:** Select prototype again, gracefully shut down, verify prototype exact SHA/build, one remote process, normal policy/profile, and canonical repo cleanliness.
- [ ] **Step 10:** Update Work Log and Owner Presentation Highlights only with verified claims, remove both Drive and native Registry entries after authoritative integration/verification, and report lifecycle remaining 0% only if prototype is restored and all gates are complete.

## Expected end state
- `prototype/free-pro-team` contains the reviewed benchmark harness.
- `C:\RDC-Benchmark` contains two independently built pinned runtimes and an evidence-preserving switcher.
- The live RDC dogfood default is prototype, with exact running SHA verified.
- Clean can be selected for controlled benchmark runs without touching the canonical prototype Git checkout.
- No product deployment, prototype→main merge, security-policy weakening, or authentication duplication occurred.
