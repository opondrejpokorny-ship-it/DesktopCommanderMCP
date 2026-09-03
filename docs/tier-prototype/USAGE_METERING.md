# Usage Metering Prototype

## Purpose

This slice measures real Desktop Commander data usage without enforcing any quota.

There is deliberately **no 1 GB limit, no monthly cap, and no blocking behavior yet**. The goal is to collect trustworthy local observations before choosing any Free-tier allowance.

The persisted state contains only:

- `returnedBytes`
- `writtenBytes`
- `periodStartedAt`

No file contents, terminal commands, paths, prompts, or MCP arguments are stored in the usage file.

## Definitions

### returnedBytes

UTF-8 byte length of `JSON.stringify(ServerResult)` for the finalized agent-driven MCP tool result.

This is measured after the handler and after any result additions such as warnings/onboarding, but excludes the outer JSON-RPC transport envelope.

UI-origin tool calls are excluded because they are human UI actions, not agent usage.

### writtenBytes

Content payload bytes accepted by successful side-effecting content tools:

- `write_file`: UTF-8 bytes of `content`
- `edit_block`: UTF-8 bytes of `new_string`, or serialized `content` for structured edits
- `write_pdf`: UTF-8/serialized bytes of `content`

Denied, approval-required, or failed writes add zero `writtenBytes`.

Terminal commands can write arbitrary files, but the server cannot reliably infer resulting disk bytes from command text. Terminal execution is therefore not guessed into `writtenBytes`.

## Why physical disk reads are not billed

Physical bytes read from disk are implementation-dependent.

For example, a small text `read_file` response can cause Desktop Commander to read the whole file internally to count lines before returning only a requested slice. Search can scan a large corpus and return a tiny result.

Charging raw filesystem I/O would therefore make the product metric unstable and unfair.

The usage metric instead tracks data actually returned to the AI plus accepted write/edit payloads.

## Persistence and concurrency

Default file:

`~/.claude-server-commander/usage-meter.json`

Tests and isolated runs can override it with:

`DESKTOP_COMMANDER_USAGE_FILE`

Updates use a small cross-process lock plus temp-file/rename persistence so concurrent Desktop Commander server processes do not silently lose increments.

A stale lock can be recovered. If the usage file is unavailable, corrupt, or the lock times out, metering fails open: the underlying Desktop Commander tool result is still returned normally.

That fail-open behavior is intentional while metering is observational only.

## Control Center contract

The human-only access-control CLI exposes:

`access-control usage`

and includes `usage` in:

`access-control state`

This lets the standalone Control Center display real counters without owning or duplicating the metering logic.

## Future decisions intentionally deferred

Before adding a quota, observe real usage and then decide:

- period/reset semantics,
- Free allowance,
- whether one operation may cross a remaining allowance,
- per-operation maximums,
- paid-tier behavior,
- reporting/aggregation.

Any future quota gate must remain a product entitlement layer and must not replace or bypass existing policy, path validation, blocked-command, or other upstream guardrails.
