# Control Center MVP

The first Control Center is intentionally local and dependency-free.

## Start

After the project is built:

```bash
node dist/npm-scripts/control-center.js
```

Default URL:

```text
http://127.0.0.1:17831/
```

A custom port can be passed as the first argument or with
`DESKTOP_COMMANDER_CONTROL_CENTER_PORT`.

## Current screens

- Current tier and profile.
- Device identity.
- Pending approvals.
- Approve / Deny.
- Recent Team audit events.
- Active policy summary.

The page refreshes automatically and never receives raw MCP arguments or file
contents from the approval store.

## Security defaults

This prototype intentionally does **not** expose the dashboard on the LAN.

- Binds to loopback only.
- Rejects non-local Host headers (basic DNS-rebinding defense).
- Generates a random session token on every launch.
- Requires the token on all API endpoints.
- Mutation requests also reject non-local browser origins.
- Sends `Cache-Control: no-store`.
- Uses CSP and blocks framing.
- Dynamic approval/audit values are inserted with DOM `textContent`, not
  `innerHTML`.

The session token is embedded only in the locally served page so the browser can
call the local API. This is a prototype local-session boundary, not OS-level
authentication.

## API

The web UI currently uses:

- `GET /api/state`
- `POST /api/approvals/:id/approve`
- `POST /api/approvals/:id/deny`

Every API request requires the `X-DC-Control-Token` header.

## Next UI iteration

The next useful additions are:

1. Policy profile selector.
2. Folder permission editor.
3. Command permission editor.
4. Device list / per-device policy assignment.
5. Audit filters and pagination.

For Team-grade multi-process operation, persistence should move behind a single
local control service or transactional database rather than independent JSON
file writers.
