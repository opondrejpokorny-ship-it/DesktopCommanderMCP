# Policy Examples — Commercial Product Only

The Pro/Team policy and approval examples that previously lived in this public prototype have moved with the active implementation to the **private Commercial product**.

They are **not implemented by Desktop Commander Free in this public repository**. Creating a local file with `tier: pro` or `tier: team`, or copying an old prototype policy example, does not activate Commercial policy enforcement or approvals in Free.

## Public Free behavior

Free preserves the shared Desktop Commander execution flow, shared `runtime/core-safety.ts` protections, and existing upstream safeguards such as allowed-directory, path, command and handler validation.

The public repository exposes versioned attachment contracts so the private Commercial product can add Pro/Team controls without importing public internals.

## Commercial behavior

The private Commercial product owns the verified paid control layer, including:

- Pro folder/read/write/terminal/command policy;
- exact-action, expiring and one-time approvals;
- policy profiles;
- Team per-device rules;
- privacy-conscious Team audit/control;
- paid Control Center extensions.

Commercial policy is additive. `ALLOW` or an approved retry must still pass through Free/shared and upstream Desktop Commander safeguards.

Human approval mutation remains outside the ordinary model-facing MCP surface. Approval and audit persistence must not store raw file contents or raw terminal commands.

## Security boundary

Do not treat a Free configuration file or UI restriction as a Pro/Team security boundary. Desktop Commander is not a complete OS security sandbox; use appropriate OS/VM/container isolation where a stronger isolation boundary is required.

For the authoritative Commercial policy examples and storage/configuration details, use the private Commercial repository documentation that accompanies the exact verified Commercial version.
