# Control Center — Public Free / Shared Host

The public Control Center is intentionally local and dependency-free. After Open-Core R3 extraction, the public repository owns only the shared/Free host and shared extensions. Pro/Team policy, approvals, device governance and audit extensions belong to the private Commercial product.

## Start

After the public project is built:

```bash
node dist/npm-scripts/control-center.js
```

Default URL:

```text
http://127.0.0.1:17831/
```

A custom port can be passed as the first argument or with `DESKTOP_COMMANDER_CONTROL_CENTER_PORT`.

## Public Free screens

The public composition currently includes shared/Free surfaces such as:

- Operational Memory;
- observational Usage metering.

The public host also exposes the versioned Control Center attachment contract so the private Commercial product can attach its own Pro/Team extensions without importing public `src/**` or undeclared `dist/**` internals.

## Security defaults

The public host intentionally binds to loopback only.

- Requires a random local control token for API requests.
- Rejects non-local Host headers.
- Rejects non-local mutation origins where mutations exist.
- Sends `Cache-Control: no-store`.
- Uses CSP and blocks framing.

The local token is a prototype browser-session boundary, not OS-level authentication.

## Public API ownership

Shared/Free APIs are defined by the public host and its attached Free extensions. Paid Pro/Team API routes are not implemented in this public source tree.

The private Commercial repository is responsible for its policy/approval/audit routes and UI when those extensions are attached through the public Control Center contract.

## Product boundary

Removing paid extensions from public composition must not remove shared Free security or workflow controls. Public `src/runtime/core-safety.ts`, existing Desktop Commander validation and handler safeguards remain authoritative for Free.
