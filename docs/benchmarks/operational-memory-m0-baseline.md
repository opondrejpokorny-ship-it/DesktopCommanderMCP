# Operational Memory M0 Scale Baseline

Date: 2026-09-04
Status: CHARACTERIZATION ONLY — no production behavior change
Device: `WIN-A0OFGC4ORFI`
OS/runtime: Windows x64, Node `v24.19.0`
Package: `@wonderwhy-er/desktop-commander@0.2.48`
Task worktree: `C:\\DesktopCommanderOperationalMemoryScaleM0`
Task branch: `feat/operational-memory-scale-m0`
Starting authoritative prototype: `f931a1ad43ac706b5ded14a610b65fb6dac6efd4`
Final characterized authoritative prototype after Active Work Enforcement integration: `6170fa2f32a442be8194586b02209f7c417af3d3`
Upstream main during M0: `ea8e9a47440ccffefede7060e0ddb490540f414d`

## Current contract characterized

- JSONL journal is keyed by project digest.
- Reader scans at most the final `512 * 1024` bytes.
- Reader considers at most `1000` parsed current-workflow events.
- Events are filtered to the active `workflowId`.
- Events are validated and fingerprints/server-controlled lesson text are reconstructed on read.
- Events are grouped by fingerprint for returned lessons.
- Model-facing status/resume returns at most `8` lessons.
- Persisted events remain privacy-safe and exclude raw MCP arguments, terminal commands/output, file contents, credentials and approval payloads.

## Passing characterization

`test/test-operational-memory-scale-characterization.js` passed against the unmodified production implementation and proved:
- a journal with more than 1000 valid current-workflow events returns exactly 1000 events;
- an otherwise valid event with a different `workflowId` is excluded;
- an old whitelisted semantic lesson can disappear after it falls outside the 512 KiB hot tail;
- 9 unique lesson fingerprints produce `uniqueLessons = 9` but only 8 returned lessons.

Command:

```bat
npm run build && node test\test-operational-memory-scale-characterization.js
```

Observed post-sync result: exit `0` with all four characterization assertions passing on `6170fa2f32a442be8194586b02209f7c417af3d3`.

## Expected RED for future architecture

`test/characterization/operational-memory-scale-expected-red.js` is deliberately outside the default test runner. On the current implementation it exits `1` for exactly two desired future behaviors:

1. a safe same-project lesson should remain available after a new/restarted workflow receives a new workflow ID;
2. an old high-value lesson should remain retrievable even after it falls outside the bounded JSONL tail.

Both REDs were reconfirmed after syncing the task branch to authoritative `6170fa2f32a442be8194586b02209f7c417af3d3`.

These are expected M0 REDs for later Scope B7 / Operational Memory M2–M3 work, not regressions in the current prototype.

## Post-sync scale benchmark

Synthetic events clone only sanitized server-generated event fields. Journals are streamed in 10,000-line chunks; the benchmark does not place one million lines in one in-memory string.
| Events | Journal bytes | Generation ms | Status ms | Append ms | RSS delta bytes | Returned events | Unique lessons | Returned lessons |
| ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| 10,000 | 2,208,890 | 33.296 | 805.114 | 6.285 | 1,548,288 | 1,000 | 1 | 1 |
| 100,000 | 22,288,890 | 365.070 | 692.553 | 4.750 | 1,126,400 | 1,000 | 1 | 1 |
| 1,000,000 | 224,888,890 | 3,404.668 | 536.329 | 2.936 | 1,069,056 | 1,000 | 1 | 1 |

Exact RSS before/after:

- 10k: `164642816` → `166191104` bytes;
- 100k: `203526144` → `204652544` bytes;
- 1M: `266326016` → `267395072` bytes.

Benchmark process exit: `0`.

## Interpretation and limits

The current reader is already bounded by the 512 KiB tail and 1000-event cap, so normal status retrieval does not rescan the complete 224.9 MB 1M-event journal. The decreasing status latency across these three points must **not** be interpreted as larger journals being faster: this is a single sequential run and runtime/filesystem cache warming is a confounder.

The append timings are similarly variable and are not a trend claim. M0 records these values as reproducible baseline evidence only; later performance budgets require repeated measurements on the target Windows host and CI.

The primary scale defect exposed by M0 is therefore not current hot-tail CPU complexity, but long-term journal growth plus loss of valuable old/project history from normal retrieval. The planned JSONL-journal + rebuildable SQLite-index architecture addresses those gaps without expanding model context.
