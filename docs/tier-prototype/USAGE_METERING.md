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

Denied or failed writes add zero `writtenBytes`. A private Commercial policy layer may also prevent a paid action before the public handler runs; such an action likewise contributes no accepted write payload.

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

The public/shared Control Center exposes the read-only Usage surface directly from the shared metering implementation. The public repository does not depend on the removed paid access-control CLI for Usage display.

Private Commercial extensions may compose additional paid views through the versioned Control Center attachment contract, but they do not own or duplicate the Free usage counters.

## Future decisions intentionally deferred

Before adding a quota, observe real usage and then decide:

- period/reset semantics,
- Free allowance,
- whether one operation may cross a remaining allowance,
- per-operation maximums,
- paid-tier behavior,
- reporting/aggregation.

Any future quota gate must remain a product entitlement layer and must not replace or bypass existing path validation, blocked-command, command validation, core-safety, or other upstream guardrails.
