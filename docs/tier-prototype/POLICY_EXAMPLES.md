# Policy Examples

The prototype keeps Desktop Commander's existing behavior when no policy file exists.

Default policy path:

`~/.claude-server-commander/policy.json`

For isolated demos/tests, override it with:

`DESKTOP_COMMANDER_POLICY_FILE=/path/to/policy.json`

## Free

No policy file is required.

```json
{
  "version": 1,
  "tier": "free",
  "rules": []
}
```

Free preserves the existing Desktop Commander execution flow and existing upstream guardrails.

## Pro — Safe Developer

```json
{
  "version": 1,
  "tier": "pro",
  "rules": [
    {
      "id": "production-writes-need-approval",
      "action": "filesystem.write",
      "resourcePrefix": "/projects/production",
      "decision": "require_approval"
    },
    {
      "id": "config-changes-need-approval",
      "action": "config.change",
      "decision": "require_approval"
    }
  ]
}
```

A matching write is stopped before the underlying Desktop Commander handler runs.
The response contains a one-time approval request ID.

## Team — Read-only Server

Each device can load a different policy file.

```json
{
  "version": 1,
  "tier": "team",
  "deviceId": "production-server-1",
  "rules": [
    {
      "id": "server-no-file-writes",
      "action": "filesystem.write",
      "deviceId": "production-server-1",
      "decision": "deny"
    },
    {
      "id": "server-terminal-needs-approval",
      "action": "terminal.execute",
      "deviceId": "production-server-1",
      "decision": "require_approval"
    },
    {
      "id": "server-no-config-changes",
      "action": "config.change",
      "deviceId": "production-server-1",
      "decision": "deny"
    }
  ]
}
```

The future Control Center will manage these policies without requiring users to edit JSON manually.

## Approval storage

Approvals default to:

`~/.claude-server-commander/approvals.json`

The store does **not** persist raw MCP arguments or file contents. It stores a SHA-256 fingerprint of the exact action, status, timestamps, rule ID, and limited safe metadata.

An approval is:

- bound to the exact tool + arguments,
- optionally bound to the matching policy rule,
- time-limited,
- one-time,
- consumed when the approved request succeeds through the gate.

The approval file can be overridden for tests with:

`DESKTOP_COMMANDER_APPROVAL_FILE=/path/to/approvals.json`

## Security boundary

This policy layer is additive. It does not replace Desktop Commander's existing path validation, blocked-command handling, or OS/container isolation. It should be described as fine-grained control and approvals, not as a complete sandbox.
