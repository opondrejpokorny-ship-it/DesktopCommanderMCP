# Free / Pro / Team Prototype — Showcase

## What this prototype demonstrates

The public Desktop Commander MCP already gives AI powerful access to a real computer.

This prototype explores a possible business layer on top:

> **Free gives AI access. Pro and Team give the user control over that access.**

It is intentionally built as two pieces.

### 1. Enforcement

Repository:

`opondrejpokorny-ship-it/DesktopCommanderMCP`

Branch:

`prototype/free-pro-team`

Responsibilities:

- evaluate policies before MCP tool execution,
- enforce folder and command rules,
- create exact one-time approvals,
- preserve existing Desktop Commander guardrails,
- record Team audit events,
- expose a human-only local control CLI.

### 2. Human Control Center

Repository:

`opondrejpokorny-ship-it/desktop-commander-control-center`

Responsibilities:

- display Free / Pro / Team state,
- display observational returned/write usage counters,
- edit policy through the enforcement CLI,
- show pending approvals,
- approve once / deny,
- show per-device rules and audit events.

The Control Center is deliberately not an MCP tool. The AI client does not get a direct mechanism to approve its own request.

## Tier concept

| Capability | Free | Pro | Team |
| --- | --- | --- | --- |
| AI can use Desktop Commander tools | Yes | Yes | Yes |
| Folder policies | — | Yes | Yes |
| Read-only / blocked folders | — | Yes | Yes |
| Writes requiring approval | — | Yes | Yes |
| Command allow / approval / block rules | — | Yes | Yes |
| Policy profiles | Basic | Yes | Yes |
| Device-specific permissions | — | — | Yes |
| Human approval queue | — | Yes | Yes |
| Structured audit log | — | Optional/local | Yes |
| Advanced workflow skills | Basic | More | Full pack |
| Private/self-hosted Remote MCP concept | — | — | Future Team/Enterprise |

This table represents the prototype/product idea, not an official Desktop Commander pricing promise.

## Architecture

```text
AI client
   |
Desktop Commander MCP
   |
central policy gate
   |
   +-- ALLOW ----------------------> existing DC handler
   |
   +-- DENY -----------------------> no side effect
   |
   +-- REQUIRE_APPROVAL -----------> pending approval
                                        |
                              Standalone Control Center
                                        |
                                  human approves
                                        |
                              human-only local CLI
                                        |
                              exact retry allowed once
                                        |
                                 existing DC handler
                                        |
                                    Team audit
```

Existing Desktop Commander filesystem and command checks still run after policy ALLOW. The prototype adds governance; it does not replace upstream safety checks.

## Real E2E proof

The strongest demo is not a mocked UI test.

A real cross-repository test was run on a connected Windows Remote Device:

1. Control Center set **Team**.
2. It used the real Remote Device ID.
3. A folder was configured as **writes require approval** for that device.
4. A real MCP client invoked `write_file`.
5. Desktop Commander blocked execution before the write handler changed the file.
6. Disk verification proved the file was unchanged.
7. The pending approval appeared in the separate Control Center.
8. The human approved it once.
9. The exact MCP retry reached the normal Desktop Commander write handler.
10. Disk verification proved the file changed.
11. The approval was consumed and could not be reused.
12. Audit contained policy, approval and execution events.
13. The written file content was absent from approval and audit storage.

Observed cross-repo result:

```text
CROSS-REPO E2E PASS
tier: Team
device-scoped rule: PASS
blocked before mutation: PASS
human approval: PASS
exact retry: PASS
real disk write after approval: PASS
audit lifecycle: PASS
raw file content persisted in approval/audit: NO
```

## Observational usage metering

The prototype also measures data usage without enforcing a quota. It tracks aggregate finalized MCP result bytes returned to the AI plus accepted write/edit payload bytes. It deliberately does not charge implementation-dependent physical disk scan bytes.

Only `returnedBytes`, `writtenBytes`, and `periodStartedAt` are persisted. Metering problems fail open and do not alter tool execution. There is currently no fixed Free allowance or automatic period reset; those product decisions are deferred until real usage has been observed.

## Security choices

The prototype deliberately includes:

- fail-closed invalid policy handling,
- one-time expiring approvals,
- exact action fingerprints,
- policy files outside ordinary MCP config mutation,
- path normalization and nested-path precedence,
- token-aware command matching,
- privacy-safe Remote Device identity discovery,
- no Remote Device access/refresh tokens in Control Center state,
- no raw file contents in approval/audit storage,
- no raw terminal command text in audit,
- loopback-only standalone Control Center,
- Host and mutation-Origin validation,
- random local control token,
- CSP / frame blocking / no-store,
- AI-inaccessible human approval CLI.

### Important boundary

This is **not a complete OS sandbox**.

Desktop Commander executes with the local user's permissions. For high-risk or enterprise environments, OS / VM / container isolation remains the stronger security boundary.

## Operational-memory skill

The prototype also includes a `software-project-workflow` skill for longer autonomous work:

**Inspect → Plan → Implement → Test → Review → Document**

It maintains a model for:

- current plan,
- whole-lifecycle progress,
- work log,
- failed attempts and lessons,
- verification,
- resumable checkpoint.

The real MCP tool `report_task_progress` applies the configured tier to each update:

- **Free:** approximate percentage remaining.
- **Pro / Team:** percentage remaining plus a rounded estimated time remaining.

ETA is explicitly approximate rather than guaranteed. The reporter uses only progress numbers and a short phase label; it does not need file contents or raw terminal commands.

This is different from generic knowledge management: it records how work was executed so a later session can continue without repeating the same mistakes.

The same workflow can also use otherwise idle wait time productively. If CI, a build, indexing, or another independent external operation is still running, the coordinator can recommend another already-planned read-only stage whose dependencies are satisfied, then direct the agent back to re-check the awaited dependency. A true blocker is not routed around, side-effecting work is not automatically selected as opportunistic work, and normal policy/approval/upstream validation remains authoritative.

## Verification

Verified before this documentation-only update:

- focused policy tests: PASS,
- real MCP policy integrations: PASS,
- full prototype suite: PASS,
- clean upstream baseline suite: PASS,
- standalone Control Center CI: PASS,
- local TypeScript build: PASS,
- real cross-repository live proof: PASS.

## 60–90 second demo

1. Open standalone Control Center.
2. Select **Team**.
3. Select the detected Remote Device.
4. Add a demo folder → **Writes need approval** → **This device**.
5. Ask AI to edit a file there.
6. Show the MCP response: approval required.
7. Show that the file did not change.
8. Show the pending approval in Control Center.
9. Click **Approve once**.
10. Ask AI to repeat the exact edit.
11. Show that the file changed.
12. Show the audit trail.

That single flow demonstrates the product thesis without needing billing, hosted infrastructure, or a marketplace.

## Intentionally deferred

- Server Builder / hosted computer.
- Billing.
- Skills marketplace.
- Full private/self-hosted relay implementation.
- Enterprise SSO / centralized RBAC.
- Background autonomous workers (the cooperative external-wait scheduler above is intentionally narrower and is not a background worker).

Those are potential product extensions after the access-control concept is proven.
