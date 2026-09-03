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

The central `CallToolRequestSchema` handler in `src/server.ts` remains the interception point, but the shared server no longer imports prototype/commercial policy code directly.

The request boundary is now:

```
MCP request
  -> shared core-safety gate
  -> EntitlementProvider
  -> CapabilityRegistry
  -> injected RuntimePolicyHook
  -> existing Desktop Commander handler / upstream validation
  -> optional policy execution-result hook
```

The default shared runtime is **Free**: `FreeEntitlementProvider` plus a no-op commercial policy hook. The current prototype entry point explicitly installs `PrototypeEntitlementProvider` and `PrototypePolicyHook`, which translate the local Free/Pro/Team selector into capabilities for demo/testing only.

Current capability examples include:

- `policy.filesystem`
- `policy.command`
- `approvals.local`
- `progress.eta`
- `team.device_policy`
- `audit.local`

This is the first open-core packaging boundary. `tsconfig.free.json` and its regression test prove that the dependency graph rooted at the shared `src/server.ts` does not require `src/policy` or `src/prototype`. It is not yet a complete independently released Free artifact; packaging/release composition remains follow-up work.

The shared core-safety gate still protects the project-workflow control plane even when commercial policy is absent. Tool-level checks such as `validatePath()` and `commandManager.validateCommand()` still run afterwards as defense in depth.

The local `tier` in `policy.json` remains only a prototype entitlement simulator. It must not become the production licensing authority.

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
- workflow.change
- external.open

### Restriction hardening semantics

- Filesystem policy resources and folder-rule prefixes are canonicalized before policy matching, so symlink/junction aliases are evaluated against their real target.
- `Read Only` is an absolute ceiling for write/move/delete, terminal execution, process/search termination, config changes, workflow mutations, and browser-opening feedback. Explicit `allow` rules cannot reopen those mutation classes. `project_workflow status` remains readable; `start`, `resume`, `record`, and `finish` are mutations.
- Managed command-prefix rules inspect common shell wrappers (`cmd`, PowerShell/pwsh, bash/sh/zsh/dash) in addition to direct commands. They are still command guardrails, not a complete shell-language or OS sandbox.
- Folder rules are scoped rules, not an implicit allowlist. A single `read_write` folder rule does not deny unmatched folders; use a broader blocked/read-only rule plus narrower exceptions when default-deny behavior is required.
- `Full Access` intentionally removes prototype default approval prompts. Because it permits arbitrary terminal execution under the same OS identity, neither prototype folder rules nor MCP filesystem control-plane denies can honestly prevent every filesystem effect performed *inside* that terminal. Stronger containment requires OS/container/process isolation or a narrower terminal policy. Existing upstream `allowedDirectories` and `blockedCommands` remain defense-in-depth guardrails and are not represented as a complete terminal sandbox.

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
- Observational usage metering may count returned/write payload bytes, but no quota is enforced yet.

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

## Usage metering

The prototype now has a separate observational metering layer. It records only aggregate `returnedBytes`, `writtenBytes`, and `periodStartedAt`; it does not persist tool contents or arguments and currently enforces no quota.

Returned usage is measured from the finalized MCP `ServerResult`, not from physical disk I/O. Accepted write/edit payload bytes are counted only for successful content-changing tools. Meter persistence is concurrency-safe across local MCP server processes and fails open so a meter problem cannot block Desktop Commander while no entitlement limit exists.

See `USAGE_METERING.md` for exact accounting semantics and deferred quota decisions.

## Project workflow coordinator

Longer software tasks can now use a versioned `.desktop-commander/project-workflow.json` profile plus the `project_workflow` MCP tool (`start`, `status`, `resume`, `record`, `finish`). Runtime state is persisted outside the repository under Desktop Commander's local control-plane directory; the repository stores only the project workflow definition.

`start` performs a local Git preflight (repository root, branch, HEAD, dirty count, sanitized remotes and known refs). `resume` refreshes that evidence. `record` stores only bounded summaries/references, never raw file contents or raw command output, and redacts common credential-shaped values. `finish` refuses completion while required stages remain incomplete, optional stages remain unresolved, or the versioned workflow profile has drifted since task start.

The coordinator also maintains a separate append-only operational-memory JSONL log under the protected workflow state root. When a failed tool call, policy denial, or approval requirement can be associated with an active project path, Desktop Commander records only a semantic failure category and static lesson metadata — never the raw MCP arguments, raw terminal command, file contents, path, approval payload, or tool output. A pathless failure (for example a terminal timeout) is associated only when exactly one active workflow exists; ambiguous multi-workflow cases are intentionally not guessed. `status` and `resume` read a bounded recent window, deduplicate repeated failures by semantic fingerprint, count occurrences, rank lessons by the current lifecycle stage/tool family/recency, and return a bounded relevant lesson set. On read, reason codes/tool families/fingerprints are revalidated and lesson text is reconstructed from built-in templates, so manually injected free-form text in the JSONL file is not propagated into model context.

The MCP initialization response also includes workflow guidance so compatible clients can automatically start/resume the coordinator for non-trivial repository work and use returned operational lessons to avoid unchanged failed approaches. This guidance is advisory because host/client behavior is implementation-dependent; the persistent coordinator is the runtime source of lifecycle state.

The coordinator also supports cooperative work scheduling around independent external waits. A stage can be recorded as `waiting_external` (distinct from a true `blocked` stop), profiles can declare earlier-stage dependencies, and status exposes `readyStages`, read-only `opportunisticStages`, `waitingStages`, and a `recommendedStage`. Existing profiles remain sequential when they omit `dependsOn`. Only stages explicitly marked `workMode: read_only` are automatically recommended during a wait; this is scheduling guidance only and never grants authorization. Optional `evidenceScope: git_head` binds evidence to the current commit so a later HEAD change marks that evidence stale and prevents completion until it is refreshed. Operational-memory lesson relevance follows the currently recommended work when one exists.

Workflow control-plane files are denied through ordinary filesystem write/move/delete paths, including canonicalized symlink aliases. Agent-controlled MCP evidence cannot mint `user_authorization`; authorization-required stages are reserved for a trusted human/control-plane signal. This coordinator does not turn Desktop Commander into a security sandbox and does not prevent a sufficiently privileged terminal/OS process from altering local files. Existing policy, approvals, allowed-directory checks, blocked-command checks and upstream validation remain authoritative.

External Drive/GitHub/CI evidence is recorded as an agent/provider attestation unless independently verified by Desktop Commander. No provider credentials are stored in workflow state.

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
