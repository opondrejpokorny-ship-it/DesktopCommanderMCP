# Free / Pro / Team — Two-Product Showcase

## Product story

Desktop Commander gives AI access to a real computer.

> **Free = access. Pro/Team = control.**

Open-Core R3 turns that product story into two independently testable products rather than paid switches hidden inside one public source tree.

## Product A — Desktop Commander Free

Public repository:

`opondrejpokorny-ship-it/DesktopCommanderMCP`

The public product owns:

- normal Desktop Commander functionality and upstream safeguards;
- shared core-safety and workflow controls;
- Operational Memory and observational Usage surfaces;
- Free capability composition;
- Commercial Contract v1;
- Control Center Contract v1 and the shared/Free local host.

The R3 extraction removes active proprietary Pro/Team policy, approval, audit and paid Control Center implementation from the public source and package artifact.

## Product B — Desktop Commander Commercial

Private repository:

`opondrejpokorny-ship-it/unoficialDesktopCommanderCommercial`

Commercial owns the proprietary control layer:

- Pro folder/read/write/terminal/command policy;
- exact-action human approvals;
- policy profiles;
- paid Control Center extensions;
- Team device governance;
- Team privacy-conscious audit.

Team extends Pro inside this Commercial product. Commercial consumes Free only through declared public package/contracts, not public `src/**` internals.

## Security composition

The intended execution shape is:

```text
MCP request
  -> shared Free/core-safety checks
  -> Commercial preflight when explicitly attached
  -> ALLOW / DENY / REQUIRE APPROVAL
  -> existing Desktop Commander validation/handler
  -> side effect
```

Commercial ALLOW never bypasses public/upstream safeguards. Approval is not authorization to skip blocked commands, allowed-directory checks, path validation, command validation or handler protections.

The public server also isolates handler arguments from Commercial preflight: the hook receives a deep-cloned JSON-compatible request, while the already-gated original arguments continue to the handler. Mutation, nested mutation, synchronous throw and asynchronous rejection are covered by negative regression tests.

## Tier concept

| Capability | Free | Pro | Team |
| --- | --- | --- | --- |
| Core Desktop Commander access | Yes | Yes | Yes |
| Shared Memory / Usage | Yes | Yes | Yes |
| Folder and command policy | — | Yes | Yes |
| Exact-action approvals | — | Yes | Yes |
| Policy profiles | — | Yes | Yes |
| Device-specific governance | — | — | Yes |
| Centralized Team audit/control | — | — | Yes |

This is a prototype/product concept, not an official Desktop Commander pricing promise.

## Approval security proof

The verified private Commercial suite covers the key negative cases:

- no side effect before approval;
- exact-action fingerprinting;
- changed arguments fail;
- denied and expired approvals fail;
- approvals are one-time and reused retries fail;
- concurrent same-action consumption is serialized;
- malformed approval storage fails closed.

## Privacy boundaries

Approval and audit persistence must not store raw file contents, unnecessary raw MCP arguments, credentials, or raw terminal commands.

The human approval mutation path belongs outside the ordinary model-facing MCP surface. UI restrictions alone are not a security boundary.

Desktop Commander is **not a complete OS security sandbox**. It still executes with the permissions of its host context, and higher-risk deployments should use appropriate OS/VM/container isolation as an additional boundary.

## Observational usage metering

Free/shared metering records aggregate finalized MCP result bytes returned to the AI plus accepted write/edit payload bytes. It does not infer physical disk scan bytes or protocol overhead.

Persisted usage data is aggregate counters only. There is currently no enforced Free quota; allowance and reset semantics remain a future product decision.

## Shared workflow capabilities

Free retains shared project workflow, Active Work coordination, progress enforcement and Operational Memory surfaces. Those shared controls are separate from the removed Commercial policy implementation and must continue to work in the standalone public product.

Progress product framing remains:

- Free: approximate percentage remaining;
- paid product: additional commercial presentation/controls only when actually attached and verified.

## R3 completion proof

Do not present the two-product split as complete merely because paid public files were deleted. Completion requires:

1. public Free extraction merged into `prototype/free-pro-team` with exact merged-SHA CI GREEN;
2. private Commercial repinned to an artifact built from that final public SHA;
3. clean independent Free and Commercial clone/build/test/run proofs;
4. real MCP cross-product security composition proof;
5. public source/package absence of active paid implementation;
6. private absence of public deep imports;
7. documentation and Active Work Registry synchronized.

## Demo framing after completion

The strongest owner-facing proof is architectural and behavioral:

- clone/build/run Free by itself;
- show the public source/package contains no active proprietary Pro/Team implementation;
- attach the private Commercial product through explicit contracts;
- demonstrate a protected action stopping before side effect;
- approve once outside ordinary MCP;
- retry exactly and execute through normal Desktop Commander safeguards;
- show changed/reused/denied/expired retries do not execute;
- show Team device/audit controls only from Commercial.

No deployment claim should be made unless an exact verified version has separately been authorized, deployed and live-checked.
