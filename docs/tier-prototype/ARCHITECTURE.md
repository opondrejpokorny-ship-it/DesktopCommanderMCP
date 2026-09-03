# Free / Pro / Team Prototype Architecture

## Goal

Prototype a monetizable control layer on top of the existing open-source Desktop Commander MCP server without reimplementing Desktop Commander's proprietary hosted Remote MCP backend.

The prototype should demonstrate:

- Free: the current low-friction Desktop Commander experience.
- Pro: fine-grained policies, approvals, and safer defaults on one or a few devices.
- Team: per-device policies, centralized approvals, and audit history.

## Upstream baseline

- Upstream: `wonderwhy-er/DesktopCommanderMCP`
- License: MIT
- Baseline: v0.2.48 / commit `ea8e9a47440ccffefede7060e0ddb490540f414d`
- Our `main` should remain a clean, fast-forwardable copy of upstream.
- Prototype work lives on `prototype/free-pro-team`.

## What already exists upstream

Desktop Commander already has useful guardrails:

- `allowedDirectories`
- `blockedCommands`
- filesystem path validation
- command parsing / validation
- remote-device code
- security regression tests
- skills

These should be reused, not replaced.

Important upstream limitation: directory restrictions and command blocklists are guardrails, not a full sandbox. Terminal commands can reach outside `allowedDirectories`, and blocklists can have bypass classes. The prototype must not claim to be an OS security boundary.

## Proposed request flow

```
AI client
   |
MCP tool request
   |
Desktop Commander CallToolRequest handler
   |
Policy Engine
   |
   +--> ALLOW ----------> existing handler/tool ----------> Audit event
   |
   +--> DENY -----------> policy response ---------------> Audit event
   |
   +--> REQUIRE_APPROVAL -> pending approval ------------> Audit event
                                  |
                           user decision
                                  |
                    approve / deny / expire
                                  |
                    execute approved action
                                  |
                             Audit event
```

## Best interception point

The cleanest first interception point is the central `CallToolRequestSchema` handler in `src/server.ts`.

Today it receives every tool name + arguments and dispatches to the existing handlers.

A policy preflight here can inspect:

- tool name
- arguments
- target path / command
- configured tier
- device identity when available

without rewriting every underlying tool.

Tool-level checks such as `validatePath()` and `commandManager.validateCommand()` must still run afterwards as defense in depth.

## Initial policy model

Every evaluated action should normalize to:

```ts
type PolicyDecision = 'allow' | 'deny' | 'require_approval';

interface PolicyContext {
  tool: string;
  action: string;
  resource?: string;
  deviceId?: string;
  tier: 'free' | 'pro' | 'team';
}
```

Initial normalized actions:

- filesystem.read
- filesystem.write
- filesystem.move
- filesystem.delete
- terminal.execute
- process.terminate
- config.change

## Approval model

First version should avoid holding an MCP request open indefinitely.

Recommended flow:

1. Policy returns `require_approval`.
2. Original action is not executed.
3. A pending approval record is created with an ID.
4. MCP returns a structured message containing that approval ID.
5. User approves or denies in the control surface.
6. AI calls an explicit execution tool with the approved request ID.
7. Approval is one-time, expiring, and tied to the exact normalized action.

This is easier to reason about and demo than a long-lived suspended MCP request.

## Audit model

Record policy-relevant events only; do not log file contents or secrets.

Suggested fields:

- timestamp
- requestId
- deviceId
- tool
- action
- resource summary
- decision
- approval state
- execution result
- duration

## Tier behavior

### Free

- Preserve current low-friction behavior.
- Existing Desktop Commander guardrails remain.
- No new approval workflow by default.

### Pro

- Policy profiles.
- Read-only / writable / blocked folder rules.
- Command policy rules.
- Require approval for selected writes or commands.
- Local audit history.
- Advanced workflow skills.

### Team

- Everything in Pro.
- Device-specific policies.
- Central policy profiles.
- Central approvals.
- Cross-device audit log.
- Private/self-hosted remote relay remains a future architecture concept, not part of the first prototype.

## First vertical slice

The first functional demo should be deliberately small:

1. Mark one folder as `write: approval_required`.
2. Attempt `write_file` through Desktop Commander.
3. Policy engine blocks execution and creates an approval request.
4. Approve the exact request.
5. Retry through an approved-action execution path.
6. File changes successfully.
7. Audit log shows request -> approval -> execution.

Once this works end-to-end, expand to commands and multiple devices.
