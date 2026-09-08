# RDC Clean vs Prototype A/B Benchmark Harness — Design

## Goal
Build a reproducible Windows harness for comparing a pinned clean upstream Desktop Commander with a pinned `prototype/free-pro-team` build without branch-flipping or mutating the canonical prototype checkout.

## Comparison contract
- Prototype source is the fork and an explicit immutable SHA.
- Clean source is upstream and an explicit immutable SHA.
- The first controlled comparison should use the upstream baseline carried by the prototype; a later latest-upstream comparison is a separate run.
- The manifest records the latest upstream SHA observed at setup so drift is visible rather than silently folded into results.
- Every benchmark run records variant, expected SHA, actual SHA, build digest, fixture identity, and timestamp.

## Host layout
`C:\RDC-Benchmark` contains `clean\repo`, `prototype\repo`, `state`, `fixtures`, `runs`, `logs`, `manifest.json`, and `active-variant.txt`.
The canonical `C:\DesktopCommanderTierPrototype` is never branch-switched by benchmark tooling.
Both benchmark repos are detached/pinned checkouts built independently from clean installs.

## Authentication and state isolation
Remote-device authentication is intentionally shared between variants through the existing real user profile. The remote device code persists refresh-token state under `~/.desktop-commander-device`; duplicating it can create diverging token families and invalidate a healthy session.
Prototype-only benchmark state is isolated with explicit environment paths for policy, approvals, audit, usage, and project workflow state.
General Desktop Commander user configuration remains the same for both variants unless a scenario explicitly snapshots and restores it; this keeps the user/environment baseline fair.
No benchmark logger may persist file contents, secrets, raw MCP argument payloads, approval payloads, or raw terminal commands.

## Switching model
`active-variant.txt` is an atomic pointer containing only `clean` or `prototype`.
Changing the pointer never kills or starts the remote process. The switch command validates the selected repo, exact SHA, and built entrypoint first; invalid or stale variants fail closed and leave the pointer unchanged.
A stable supervisor reads the pointer only before launching a remote child. The current device is stopped through Desktop Commander's graceful shutdown path; after exit, the supervisor validates again and launches the selected build.
Every non-validation supervisor must first acquire one host-wide named mutex scoped to the Windows user identity and hold it for its entire management lifetime. A second supervisor fails clearly, abandoned ownership is recovered, and the owner re-checks known remote processes immediately before every launch. `-ValidateOnly` does not acquire the mutex or create directories, logs, locks, or other artifacts.
During first activation the supervisor waits while the pre-existing prototype dogfood process is still alive.
The normal/default state after setup, smoke tests, errors, and benchmark batches is `prototype`.

## Launcher installation and rollback
The existing `start-remote.cmd` is backed up byte-for-byte before installation. Re-installation never overwrites the first valid backup.
The installed launcher is a minimal delegator to the stable supervisor under `C:\RDC-Benchmark`.
Installation only validates, backs up, and writes the delegator. A separate activation step validates the installed bytes and selected variant, finds exactly one `cmd.exe` whose `/c` or `/k` target is the supplied launcher path, stops only that watcher, and starts the installed delegator. Zero or multiple exact matches fail closed. The live RDC node child is not killed and continues until a separate graceful shutdown.
Activation is completed by a graceful RDC shutdown, reconnect, and exact prototype verification.
Rollback requires prototype selected and healthy, refuses to modify the launcher while a benchmark supervisor owns the identity mutex, restores the original launcher atomically, and preserves benchmark evidence.

## Fixture reset
Fixture templates are immutable inputs. A reset creates a fresh per-run working directory rather than mutating the template.
Git fixtures must start at their declared commit with no untracked files. Reset refuses paths outside the benchmark root.
Run metadata contains only identifiers, hashes, timings, outcome summaries, and allowed counters.

## Failure handling
- Missing manifest, invalid schema, unknown variant, SHA mismatch, missing `dist/index.js`, or unexpected repo path: fail closed and do not launch.
- Setup failure leaves the existing dogfood launcher and live process untouched.
- Switch failure leaves the currently active pointer unchanged.
- Supervisor child crash is logged with variant/SHA/exit code only, then retried with bounded delay; it never silently falls back to the other variant.
- A host smoke that cannot return to prototype is a benchmark-harness failure and must be reported immediately.

## Security boundaries
The harness does not weaken upstream `allowedDirectories`, blocked commands, path validation, policy evaluation, approvals, or handler checks.
It does not add an MCP surface for mutating human approvals or commercial policy.
The clean build remains genuinely clean upstream code; prototype environment variables are not injected into clean unless they are generic benchmark controls shared by both variants.
The benchmark is not a security sandbox and must not be described as one.

## Verification gates
1. Cross-platform unit tests prove manifest validation, exact-SHA checking, atomic selection, path containment, metadata redaction, and fixture reset behavior.
2. Windows-focused tests prove host scripts reject invalid roots, preserve the current launcher during dry-run/setup failures, exclude concurrent supervisors, keep concurrent validation side-effect-free, and hand off the exact old watcher without terminating its child.
3. Both clean and prototype pinned repos independently install and build.
4. Status reports the exact selected and running variant/SHA before any scored run.
5. A live smoke switches prototype → clean → prototype using graceful shutdown and proves reconnect each time.
6. Final state is prototype selected, prototype running, canonical checkout clean, and original project policy/config not broadened.

## Non-goals
This slice does not yet define the full scored scenario catalog or claim benchmark superiority. It prepares the reproducible switching/runtime foundation on which that experiment will run.
