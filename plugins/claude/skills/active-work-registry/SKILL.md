---
name: active-work-registry
description: Coordinate parallel software work across sessions and Git worktrees with Desktop Commander's native active_work_registry tool. Use before material repository edits, when resuming concurrent work, or when deciding whether another task can proceed safely.
---

# Active Work Registry

Use Desktop Commander's native `active_work_registry` tool to coordinate unfinished
software work across multiple agent sessions and Git worktrees.

The registry is current coordination state, not project history.

## Required lifecycle

1. **Before editing** a repository for material work, call `active_work_registry`
   with `action: "check"` and describe the intended scope, affected areas, and
   important risk areas.
2. Interpret the returned guidance conservatively:
   - `safe_parallel` — no conflicting registered work was found. Call
     `action: "register"` before the first material edit.
   - `continue_existing` — the same task appears to be active already. Reuse or
     continue that work only when sharing the existing branch/worktree is clearly
     intended and safe. Do not duplicate it.
   - `wait_or_read_only` — overlapping work exists. Do not concurrently mutate
     the overlapping area. Prefer useful read-only analysis, unrelated already
     planned work, or wait for the conflicting work to integrate.
3. Use `action: "update"` only for meaningful changes such as branch/head state,
   affected scope, a blocker/conflict, or the next action.
4. Use `action: "list"` when resuming work or when another session may have
   changed the active state.
5. Use `action: "remove"` only after the work is integrated into its
   **authoritative target**, intended verification has passed, and required
   durable Work Log/documentation has been updated.

**Branch/worktree existence does NOT prove** that a task is active. Old branches
and worktrees may remain after integration. The native registry is the active
coordination surface; Git history and durable project documentation are the
historical record.

## Conflict descriptions

Keep `affectedAreas` repository-relative and structural, for example:

- `src/policy`
- `src/workflow/project-workflow.ts`
- `skills/software-project-workflow`

Use `riskAreas` for shared contracts where two edits may conflict even when
files differ, for example:

- `workflow-control-plane`
- `approval-contract`
- `persistence`
- `security-policy`

Prefer narrower accurate scopes over broad guesses.

## Security and privacy

The registry is **guidance, not authorization**. A `safe_parallel` result never
overrides Desktop Commander policy, exact-action approvals, allowed-directory
checks, blocked-command checks, command/path validation, or upstream handler
validation.

**Never store secrets** in registry metadata. Do not put credentials, tokens,
raw terminal commands, raw MCP arguments, file contents, approval payloads, or
raw tool output into titles, scope, next action, or conflict notes. Record a
short sanitized description instead.

Do not remove another session's entry merely to make a conflict disappear.
Resolve the real coordination state first.
