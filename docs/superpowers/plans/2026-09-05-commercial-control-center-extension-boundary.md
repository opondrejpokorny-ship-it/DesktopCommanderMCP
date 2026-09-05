# C3 Control Center Extension Boundary Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Split the monolithic prototype Control Center into a PUBLIC security-owning host plus trusted Pro, Team, and demo extensions without weakening approvals, policy, upstream safeguards, or Free open-core packaging.

**Architecture:** Introduce a separately versioned `./control-center-contract` public package surface and a PUBLIC host that owns loopback binding, Host/token/origin checks, capability gating, bounded request parsing, security headers, routing, and shell composition. Pro/Team/demo implementation remains outside the public host and is registered explicitly by trusted server-side composition; the current prototype launcher is recomposed from those extensions.

**Tech Stack:** TypeScript, Node.js `http`, existing entitlement/capability contracts, existing policy/approval/audit stores, inline Control Center HTML/JS, Node assert-based tests, npm packaging proof.

**Spec:** `docs/superpowers/specs/2026-09-05-commercial-control-center-extension-boundary-design.md`

## Global Constraints

- Start implementation from the then-current authoritative `origin/prototype/free-pro-team`; never from the docs branch commit.
- Re-read Active Work Registry immediately before runtime edits and keep M3B/M6/M8 ownership intact.
- C1 `COMMERCIAL_CONTRACT_VERSION = 1` and its tested whitelist remain unchanged.
- PUBLIC code may import only PUBLIC/shared code; Pro may import PUBLIC+Pro; Team may import PUBLIC+Pro+Team.
- Human approval mutation remains outside the ordinary model-facing MCP surface.
- Host performs Host/token/capability/non-GET-origin checks before calling any extension handler.
- Extension handlers never receive raw `ServerResponse` or direct socket/header mutation access.
- Production composition never exposes tier mutation; `setPolicyTier()` remains demo-only.
- Free proof must clean-install and start the PUBLIC host with zero paid/demo extensions.
- No M6 Operational Memory implementation or M3B persistence/retrieval changes in C3.
- No deployment without explicit user authorization.

---

## File Structure

- Create `src/control-center/contract.ts`: versioned PUBLIC extension/request/response/UI contribution types.
- Create `src/control-center/host.ts`: PUBLIC loopback server, security envelope, extension registration/router, neutral state and shell renderer.
- Create `src/control-center/pro-extension.ts`: Pro policy/profile/folder/command/approval API + UI contribution.
- Create `src/control-center/team-extension.ts`: Team device/audit API + UI contribution.
- Create `src/control-center/demo-extension.ts`: demo-only tier mutation API/UI.
- Rewrite `src/control-center/server.ts` into thin prototype composition using PUBLIC host + Pro + Team + demo extensions.
- Create `src/control-center-contract.ts`: public package subpath entrypoint for host/contract v1.
- Modify `package.json`: add `./control-center-contract` export without changing `./commercial-contract`.
- Modify `docs/tier-prototype/open-core-boundaries.json`: mark host/contract PUBLIC and extension implementations Pro/Team/demo.
- Modify `scripts/build-free-package.cjs` and `tsconfig.free-package.json`: emit/package PUBLIC Control Center host/contract while excluding paid/demo extensions.
- Create `test/test-control-center-contract-v1.js`: versioned export/declaration whitelist.
- Create `test/test-control-center-public-host.js`: host security, routing, collision, capability and origin negative tests.
- Create `test/test-c3-control-center-pro-extension.js`: Pro-only policy/approval behavior with no Team dependency.
- Create `test/test-c3-control-center-team-extension.js`: Team audit/device behavior and Pro-without-Team negative proof.
- Create `test/test-c3-control-center-demo-extension.js`: demo tier mutation isolation.
- Modify `test/test-tier-control-center.js`: current prototype behavior against recomposed extensions.
- Modify `test/test-open-core-extraction-boundary.js` and `test/test-free-package-artifact.js`: permanent C3/Open Core gates.

---

### Task 1: Freeze Control Center Contract v1

**Files:**
- Create: `src/control-center/contract.ts`
- Create: `src/control-center-contract.ts`
- Modify: `package.json`
- Create: `test/test-control-center-contract-v1.js`

**Interfaces:**
- Consumes: `Capability`, `EntitlementProvider`, `EntitlementSnapshot` from PUBLIC entitlement contracts.
- Produces: `CONTROL_CENTER_CONTRACT_VERSION`, route/extension/request/response/UI types and later `startControlCenterHost` export.

- [ ] **Step 1: Write the contract RED**

Create `test/test-control-center-contract-v1.js` asserting existing `package.json.exports['./commercial-contract']` and `package.json.exports['./*']` remain unchanged while `package.json.exports['./control-center-contract']` points to `dist/control-center-contract.js/.d.ts`, import of the package subpath works, `CONTROL_CENTER_CONTRACT_VERSION === 1`, and declarations contain only approved PUBLIC host/composition types. Explicitly reject `policy/`, `approval-store`, `audit-store`, `prototype`, `setPolicyTier`, `ProjectId`, `RepositoryId`, and Operational Memory implementation names.

```js
const contract = await import('@wonderwhy-er/desktop-commander/control-center-contract');
assert.equal(contract.CONTROL_CENTER_CONTRACT_VERSION, 1);
assert.deepEqual(Object.keys(contract).sort(), [
  'CONTROL_CENTER_CONTRACT_VERSION',
].sort());
```

- [ ] **Step 2: Run RED**

Run: `npm.cmd run build && node test/test-control-center-contract-v1.js`
Expected: FAIL because `./control-center-contract` and its source entrypoint do not exist.

- [ ] **Step 3: Implement the minimal v1 types**

Define the concrete contract with these stable names:

```ts
export type ControlCenterMethodV1 = 'GET' | 'POST';
export interface ControlCenterJsonResponseV1 { status: number; body: unknown; }
export interface ControlCenterRequestContextV1 {
  method: ControlCenterMethodV1;
  pathname: string;
  params: Readonly<Record<string, string>>;
  query: Readonly<Record<string, readonly string[]>>;
  entitlement: EntitlementSnapshot;
  readJsonBody(maxBytes?: number): Promise<unknown>;
}
export interface ControlCenterRouteV1 {
  method: ControlCenterMethodV1;
  apiPrefix: `/api/${string}`;
  path: string;
  requiredCapabilities?: readonly Capability[];
  handle(context: ControlCenterRequestContextV1): Promise<ControlCenterJsonResponseV1>;
}
```

```ts
export interface ControlCenterUiContributionV1 {
  viewId: string;
  label: string;
  html: string;
  script?: string;
}
export interface ControlCenterExtensionV1 {
  id: string;
  apiPrefixes: readonly `/api/${string}`[];
  requiredCapabilities?: readonly Capability[];
  routes: readonly ControlCenterRouteV1[];
  ui?: ControlCenterUiContributionV1;
}
export interface ControlCenterHostOptionsV1 {
  host?: '127.0.0.1' | 'localhost' | '::1';
  port?: number;
  token?: string;
  quiet?: boolean;
  entitlementProvider?: EntitlementProvider;
  extensions?: readonly ControlCenterExtensionV1[];
}
export interface RunningControlCenterHostV1 {
  host: string;
  port: number;
  token: string;
  url: string;
  close(): Promise<void>;
}
```

Keep UI contribution strings static/trusted product code only; dynamic server data must later be rendered through client `.textContent`.

- [ ] **Step 4: Add `src/control-center-contract.ts` and package export**

Export the v1 types plus `CONTROL_CENTER_CONTRACT_VERSION = 1`. Task 1 intentionally exposes no host runtime function yet; Task 2 adds `startControlCenterHost` and updates this same contract test to the final v1 runtime whitelist before any PR is opened.

- [ ] **Step 5: Run contract/build GREEN for the type/export surface**

Run: `npm.cmd run build && node test/test-control-center-contract-v1.js && node test/test-commercial-contract-v1.js`
Expected: PASS for both contracts; C1 whitelist remains unchanged.

- [ ] **Step 6: Commit Task 1**

```bash
git add src/control-center/contract.ts src/control-center-contract.ts package.json test/test-control-center-contract-v1.js
git commit -m "feat: add Control Center contract v1"
```

---

### Task 2: PUBLIC host and security-owned extension dispatcher

**Files:**
- Create: `src/control-center/host.ts`
- Modify: `src/control-center-contract.ts`
- Create: `test/test-control-center-public-host.js`
- Modify: `test/test-control-center-contract-v1.js`

**Interfaces:**
- Consumes: Task 1 contract types and PUBLIC `FreeEntitlementProvider` / capability types.
- Produces: `startControlCenterHost(options?: ControlCenterHostOptionsV1): Promise<RunningControlCenterHostV1>`.

- [ ] **Step 1: Write host security REDs**

Test a fake extension whose handler increments a counter. Assert startup rejects reserved/duplicate/overlapping namespaces, invalid Host returns 400, missing token returns 403, missing required capability returns 404 without incrementing the counter, and non-GET foreign Origin returns 403 without running the handler.

```js
const protectedExtension = {
  id: 'test-protected',
  apiPrefixes: ['/api/test'],
  requiredCapabilities: ['policy.config'],
  routes: [{
    method: 'POST', apiPrefix: '/api/test', path: '/run',
    async handle() { calls += 1; return { status: 200, body: { ok: true } }; },
  }],
};
```

Also assert response headers retain `Cache-Control: no-store`, `X-Frame-Options: DENY`, restrictive CSP, and generic 500 behavior when a handler throws.

- [ ] **Step 2: Run RED**

Run: `npm.cmd run build && node test/test-control-center-public-host.js`
Expected: FAIL because the PUBLIC host/dispatcher does not exist.

- [ ] **Step 3: Extract host-only security helpers**

Move/reimplement from current `server.ts` into `host.ts`: loopback host type, token generation/timing-safe comparison, Host parsing, origin validation, bounded JSON-body reader, security headers, JSON/text response helpers, listen/close lifecycle. PUBLIC host must import no `src/policy/*`, `src/prototype/*`, Team or demo implementation.

- [ ] **Step 4: Implement fail-closed registration validation**

At startup validate `extension.id`, every `/api/...` prefix, each route `apiPrefix` membership, route method/path syntax, reserved prefixes (`/api/state`, `/`, `/favicon.ico`), and collisions. Route paths are relative to their selected owned prefix, allow static segments plus named single-segment `:param`, and reject catch-all/wildcard patterns in v1.

- [ ] **Step 5: Implement request gate ordering**

For extension API requests enforce exactly:

```text
local Host -> /api classification -> session token -> registered route
-> fresh entitlement snapshot -> extension+route capabilities
-> non-GET local Origin -> bounded host request context -> handler
-> host-owned JSON serialization/security headers
```

Use `FreeEntitlementProvider` when no provider is supplied.

- [ ] **Step 6: Implement neutral shell/state**

`GET /api/state` returns only `{ generatedAt, entitlement, activeExtensions }`. Root HTML provides title/navigation and a browser helper `window.dcControlCenter.api()` that always adds the session token. Static trusted `ui.html` and `ui.script` contributions are composed by the host; extension scripts receive data only through API calls.

- [ ] **Step 7: Freeze the final v1 runtime whitelist**

Update `test/test-control-center-contract-v1.js` so runtime exports are exactly `CONTROL_CENTER_CONTRACT_VERSION` and `startControlCenterHost`; declarations still contain only approved PUBLIC types and no commercial implementation names.

- [ ] **Step 8: Run GREEN**

Run: `npm.cmd run build && node test/test-control-center-public-host.js && node test/test-control-center-contract-v1.js`
Expected: PASS.

- [ ] **Step 9: Commit Task 2**

```bash
git add src/control-center/host.ts src/control-center-contract.ts test/test-control-center-public-host.js test/test-control-center-contract-v1.js
git commit -m "feat: add public Control Center host"
```

---

### Task 3: Pro policy + approval extension

**Files:**
- Create: `src/control-center/pro-extension.ts`
- Create: `test/test-c3-control-center-pro-extension.js`

**Interfaces:**
- Consumes: PUBLIC Control Center contract plus Pro policy/approval modules.
- Produces: `createProControlCenterExtension(options?: { auditSink?: AuditSink }): ControlCenterExtensionV1`.

- [ ] **Step 1: Write Pro REDs**

Start the PUBLIC host with a Pro entitlement and only `createProControlCenterExtension()`. Seed a pending approval and isolated policy file. Assert the extension exposes sanitized Pro state, profile/folder/command mutation, approval approve/deny, and never requires Team audit/device modules to load.

Assert `JSON.stringify()` of state/approval responses does not contain seeded file-content marker `PRIVATE_PRO_FILE_CONTENT` or raw terminal marker `rm -rf PRIVATE_COMMAND`.

- [ ] **Step 2: Run RED**

Run: `npm.cmd run build && node test/test-c3-control-center-pro-extension.js`
Expected: FAIL because the Pro extension does not exist.

- [ ] **Step 3: Implement Pro routes**

Use namespace `/api/pro` with these v1 routes:

```text
GET  /api/pro/state
POST /api/pro/profile/:profile
POST /api/pro/folders
POST /api/pro/commands
POST /api/pro/approvals/:id/approve
POST /api/pro/approvals/:id/deny
```

Set the Pro extension-level `requiredCapabilities` to `['policy.config', 'approvals.local']` so the Pro view is active only for a complete Pro entitlement. Require `policy.config` for policy state/mutation and `approvals.local` for approval routes. Reuse existing validators/stores; do not duplicate policy semantics. Pass optional injected `AuditSink` to `setApprovalDecision`; absence of Team audit must not block Pro approval mutation.

- [ ] **Step 4: Implement Pro UI contribution**

Move the current profile/folder/command and pending-approval UI into the Pro contribution. Remove tier and Team-device/audit rendering from this extension. All server-returned strings are inserted with `.textContent`; mutations use `window.dcControlCenter.api()`.

- [ ] **Step 5: Run GREEN + approval security regressions**

Run:
`npm.cmd run build && node test/test-c3-control-center-pro-extension.js && node test/test-tier-approval-store.js && node test/integration/policy-terminal-approval.js`
Expected: PASS; `test-tier-approval-store.js` covers approval decision/persistence behavior and `policy-terminal-approval.js` covers the protected terminal approval lifecycle.

- [ ] **Step 6: Commit Task 3**

```bash
git add src/control-center/pro-extension.ts test/test-c3-control-center-pro-extension.js
git commit -m "feat: extract Pro Control Center extension"
```

---

### Task 4: Team device + audit extension

**Files:**
- Create: `src/control-center/team-extension.ts`
- Create: `test/test-c3-control-center-team-extension.js`

**Interfaces:**
- Consumes: PUBLIC Control Center contract, Team `audit-store.ts` and `device-identity.ts`, and Pro policy runtime only where Team device-scoped policy composition legitimately builds on Pro.
- Produces: `createTeamControlCenterExtension(): ControlCenterExtensionV1`.

- [ ] **Step 1: Write Team REDs**

Start one host with Pro entitlement + Pro extension only and assert `/api/team/*` is 404. Start another with Team entitlement + Pro + Team extensions, seed remote-device config containing fake auth tokens plus audit events, and assert `/api/team/device` returns only `deviceId` identity and `/api/team/audit` returns sanitized bounded audit metadata without auth tokens/raw command/file content.

Also assert a Pro-only entitlement cannot execute a Team route even if the Team extension object was mistakenly registered: host returns 404 and the handler/store mutation is not reached.

- [ ] **Step 2: Run RED**

Run: `npm.cmd run build && node test/test-c3-control-center-team-extension.js`
Expected: FAIL because the Team extension does not exist.

- [ ] **Step 3: Implement Team routes**

Set the Team extension-level `requiredCapabilities` to `['team.device_policy', 'audit.local']` so the Team view is active only for a complete Team entitlement. Use namespace `/api/team`:

```text
GET  /api/team/device                 requires team.device_policy
POST /api/team/device                 requires team.device_policy
GET  /api/team/audit                  requires audit.local
```

`GET /device` returns only `{ detectedDeviceIdentity: { deviceId } | null }`; never return remote-device session/auth tokens. `GET /audit` returns only bounded sanitized audit events. `POST /device` validates non-empty device ID and delegates to existing `setPolicyDeviceId()`.

- [ ] **Step 4: Implement Team UI contribution**

Move current detected-device selection and audit list into the Team contribution. Audit rendering remains bounded to the existing recent-event limit and uses `.textContent`.

- [ ] **Step 5: Run GREEN + Team regressions**

Run: `npm.cmd run build && node test/test-c3-control-center-team-extension.js && node test/test-tier-device-scoped-rules.js && node test/test-tier-device-identity.js && node test/test-tier-audit-store.js && node test/integration/policy-team-audit.js`
Expected: C3 Team test and focused Team tests PASS. If Windows temp-path casing causes the already-known baseline-only audit assertion, reproduce the same exact failure on authoritative baseline before classifying it non-regression.

- [ ] **Step 6: Commit Task 4**

```bash
git add src/control-center/team-extension.ts test/test-c3-control-center-team-extension.js
git commit -m "feat: extract Team Control Center extension"
```

---

### Task 5: Demo-only tier extension and prototype recomposition

**Files:**
- Create: `src/control-center/demo-extension.ts`
- Rewrite: `src/control-center/server.ts`
- Modify: `test/test-tier-control-center.js`
- Create: `test/test-c3-control-center-demo-extension.js`

**Interfaces:**
- Consumes: PUBLIC host, Pro/Team extensions, `PrototypeEntitlementProvider`, `getPrototypeAuditSink()`, and demo-only `setPolicyTier()`.
- Produces: existing `startControlCenter(options)` compatibility wrapper for the prototype/demo launcher.

- [ ] **Step 1: Write demo isolation RED**

Assert `src/control-center/demo-extension.ts` is the only Control Center source importing `setPolicyTier()`. Start the demo extension with prototype entitlement and assert `POST /api/demo/tier/team` changes the prototype tier, while a PUBLIC host with no demo extension returns 404 for the same route.

- [ ] **Step 2: Run RED**

Run: `npm.cmd run build && node test/test-c3-control-center-demo-extension.js`
Expected: FAIL because tier mutation is still embedded in monolithic `server.ts`.

- [ ] **Step 3: Implement demo extension**

Use namespace `/api/demo` with `POST /api/demo/tier/:tier`. Validate through `isDesktopCommanderTier()` and delegate to `setPolicyTier()`. Its UI contribution contains the Free/Pro/Team selector and calls only `/api/demo/tier/...`.

- [ ] **Step 4: Recompose `server.ts`**

Reduce `server.ts` to this prototype composition shape (plus required imports/type aliases only):

```ts
export async function startControlCenter(options = {}) {
  const entitlementProvider = new PrototypeEntitlementProvider();
  const auditSink = await getPrototypeAuditSink();
  return startControlCenterHost({
    ...options,
    entitlementProvider,
    extensions: [
      createProControlCenterExtension({ auditSink }),
      createTeamControlCenterExtension(),
      createDemoControlCenterExtension(),
    ],
  });
}
```

Preserve `ControlCenterOptions`/`RunningControlCenter` compatibility by aliasing PUBLIC host types if needed. Do not add demo composition to the PUBLIC contract.

- [ ] **Step 5: Update current integration test to recomposed endpoints**

Keep existing Host/token/CSP/no-store, policy/profile/folder/command, approval, device, audit and privacy assertions. Update endpoint paths to `/api/pro/*`, `/api/team/*`, `/api/demo/*` and assert `/api/state` is host-neutral rather than paid-state aggregate.

- [ ] **Step 6: Run GREEN**

Run: `npm.cmd run build && node test/test-c3-control-center-demo-extension.js && node test/test-tier-control-center.js`
Expected: PASS with the existing user-visible demo capabilities preserved through recomposition.

- [ ] **Step 7: Commit Task 5**

```bash
git add src/control-center/demo-extension.ts src/control-center/server.ts test/test-tier-control-center.js test/test-c3-control-center-demo-extension.js
git commit -m "refactor: recompose prototype Control Center"
```

---

### Task 6: Open-core ownership + real Free Control Center proof

**Files:**
- Modify: `docs/tier-prototype/open-core-boundaries.json`
- Modify: `test/test-open-core-extraction-boundary.js`
- Modify: `tsconfig.free-package.json`
- Modify: `scripts/build-free-package.cjs`
- Modify: `test/test-free-package-artifact.js`

**Interfaces:**
- Consumes: Tasks 1-5 source split.
- Produces: permanent ownership/package proof that PUBLIC host/contract ship in Free while Pro/Team/demo extensions do not.

- [ ] **Step 1: Write ownership/package REDs**

Extend the Open Core test so `src/control-center/contract.ts`, `src/control-center/host.ts`, and `src/control-center-contract.ts` must resolve PUBLIC; `pro-extension.ts` must resolve Pro; `team-extension.ts` Team; `demo-extension.ts` and prototype `server.ts` demo. Add `src/control-center-contract.ts` to required public contracts.

Extend Free artifact assertions: require `dist/control-center-contract.js`, `dist/control-center/host.js`, and their PUBLIC dependencies; forbid `dist/control-center/pro-extension.js`, `team-extension.js`, `demo-extension.js`, prototype `server.js`, all `dist/policy/*`, and `dist/prototype/*`.

- [ ] **Step 2: Run RED**

Run: `npm.cmd run build && node test/test-open-core-extraction-boundary.js && npm.cmd run build:free-package && node test/test-free-package-artifact.js`
Expected: ownership/package proof FAIL until classification and Free roots/package exports are updated.

- [ ] **Step 3: Update machine-readable ownership**

Replace blanket demo ownership of `src/control-center` with explicit file/directory rules matching the task split. Keep `src/npm-scripts/control-center.ts` demo because it launches prototype composition.

- [ ] **Step 4: Emit PUBLIC Control Center roots in Free build**

Add `src/control-center-contract.ts` as a root in `tsconfig.free-package.json`. In generated Free `package.json`, expose:

```json
{
  "exports": {
    ".": "./dist/index.js",
    "./control-center-contract": {
      "types": "./dist/control-center-contract.d.ts",
      "import": "./dist/control-center-contract.js"
    }
  }
}
```

Set `compilerOptions.declaration` to `true` in `tsconfig.free-package.json` so the Free proof emits its own declaration graph; do not copy declarations from the normal build.

- [ ] **Step 5: Add real clean-install/start smoke**

After `npm pack`, clean-install the tarball into the existing temporary consumer fixture used by `test-free-package-artifact.js`, import `startControlCenterHost`, start it on `127.0.0.1:0` with no extensions, fetch `/`, authenticate `/api/state`, assert only Free entitlement + zero active extensions, then close the server. Also assert importing Pro/Team/demo extension paths returns `MODULE_NOT_FOUND`/`ERR_PACKAGE_PATH_NOT_EXPORTED`.

- [ ] **Step 6: Run GREEN**

Run: `npm.cmd run build && node test/test-open-core-extraction-boundary.js && npm.cmd run build:free-package && node test/test-free-package-artifact.js && node test/test-commercial-contract-v1.js && node test/test-control-center-contract-v1.js`
Expected: PASS on platforms where the existing npm-pack child-process baseline works; Linux Open Core CI is authoritative for the actual tarball if local Windows reproduces the known `spawnSync npm.cmd EINVAL` baseline.

- [ ] **Step 7: Commit Task 6**

```bash
git add docs/tier-prototype/open-core-boundaries.json test/test-open-core-extraction-boundary.js tsconfig.free-package.json scripts/build-free-package.cjs test/test-free-package-artifact.js
git commit -m "test: prove public Control Center open-core boundary"
```

---

### Task 7: Security regression, readiness docs, PR/CI and authoritative integration

**Files:**
- Modify: `docs/tier-prototype/open-core-extraction-readiness.md`
- Verification-only: all C3 files/tests plus existing policy/approval/open-core/real-MCP suites.

**Interfaces:**
- Consumes: complete Tasks 1-6 implementation.
- Produces: reviewed C3 diff, integrated authoritative prototype, exact merged-SHA evidence and durable project documentation.

- [ ] **Step 1: Update extraction readiness truthfully**

Change the Control Center inventory from “demo monolith” to PUBLIC host/contract + Pro/Team/demo extensions. Record that this enables later private `DesktopCommanderCommercial` composition but does not itself create private distribution, signed entitlement, billing, DRM or deployment. Record M6’s PUBLIC read-only Memory extension target.

- [ ] **Step 2: Run fresh focused security suite**

Run:

```powershell
npm.cmd run build
node test/test-control-center-contract-v1.js
node test/test-control-center-public-host.js
node test/test-c3-control-center-pro-extension.js
node test/test-c3-control-center-team-extension.js
node test/test-c3-control-center-demo-extension.js
node test/test-tier-control-center.js
node test/test-tier-approval-store.js
node test/test-tier-device-identity.js
node test/test-tier-device-scoped-rules.js
node test/test-tier-audit-store.js
node test/test-c2-policy-runtime-team-decoupling.js
node test/test-c2-policy-control-plane-protection.js
node test/test-open-core-extraction-boundary.js
node test/test-commercial-contract-v1.js
git diff --check
```

Expected: all C3 and relevant focused tests PASS. Any failure claimed baseline-only must first be reproduced on the exact current authoritative prototype SHA.

- [ ] **Step 3: Run real/integration approval + Team audit checks**

Run:

```powershell
node test/integration/policy-terminal-approval.js
node test/integration/policy-team-audit.js
```

Expected: terminal approval lifecycle PASS; Team audit PASS or the known Windows temp-path casing assertion reproduced identically on exact baseline and then relied on Linux CI for authoritative integration proof.

- [ ] **Step 4: Run full unit regression**

Run: `node test/run-all-tests.js`
Expected: no C3 regression. Existing environment-only `python` and Windows `npm.cmd spawnSync` failures, if still present, require exact-baseline reproduction before classification.

- [ ] **Step 5: Full diff/security review**

Run `$base = git merge-base HEAD origin/prototype/free-pro-team` and review `git diff "$base...HEAD" --`; assert: no Operational Memory persistence/retrieval changes; no C1 v1 whitelist expansion; no Pro import of Team; no PUBLIC import of Pro/Team/demo; only demo extension imports `setPolicyTier`; no handler receives raw `ServerResponse`; no sensitive response broadening.

- [ ] **Step 6: Independent Codex read-only review when safely available**

Use `C:\DesktopCommanderDevTools\bin\dc2-codex.mjs` with exact clean C3 HEAD, `mode=read_only`, and checks focused on host-gate bypass, namespace collision, capability downgrade/expiry, approval self-authorization, public/private dependency leaks, Free packaging and M6 compatibility. Do not bypass wrapper credential/sandbox guards. Independently reproduce any material finding before changing code.

- [ ] **Step 7: Commit final docs/verification adjustments**

```bash
git add docs/tier-prototype/open-core-extraction-readiness.md
git commit -m "docs: record Control Center extraction readiness"
```

Skip this commit only if the readiness file required no textual change; do not create an empty commit.

- [ ] **Step 8: Re-read Registry and authoritative target before push/PR**

Fetch `origin prototype/free-pro-team` and `upstream main`; verify branch/HEAD/status/remotes and compare the C3 branch to the newest prototype. If the prototype advanced, integrate it safely into the isolated C3 branch without rewriting unrelated history, rerun exact-head verification, and update Registry SHA/evidence.

- [ ] **Step 9: Push and open PR to prototype only**

Push the C3 implementation branch and open a PR with base `prototype/free-pro-team`, never `main`. Confirm the GitHub diff contains only intended C3/readiness changes and record exact head SHA in Work Log/Registry.

- [ ] **Step 10: Require PR CI GREEN**

Inspect all PR-triggered workflows. At minimum require Prototype CI, Open Core Composition Proof, Policy Engine RED-GREEN where triggered, and Graphify Tooling CI where triggered. The Linux Open Core job must prove actual Free tarball build/install/public-host start and paid-extension absence.

- [ ] **Step 11: Merge with expected-head protection**

Merge only after all intended gates are GREEN, using the exact reviewed PR head SHA as expected-head protection. Do not merge to `main`.

- [ ] **Step 12: Verify exact merged SHA**

Read `origin/prototype/free-pro-team` again and record the exact merge SHA. Require intended post-merge workflows on that exact SHA to reach SUCCESS before documentation cleanup.

- [ ] **Step 13: Safely synchronize canonical checkout**

If `C:\DesktopCommanderTierPrototype` is still clean and can fast-forward, fetch and `merge --ff-only origin/prototype/free-pro-team`. Never reset/stash/rebase a dirty or divergent canonical checkout.

- [ ] **Step 14: Run final merged-SHA local smoke**

Run from canonical checkout:

```powershell
npm.cmd run build
node test/test-control-center-contract-v1.js
node test/test-control-center-public-host.js
node test/test-tier-control-center.js
node test/test-open-core-extraction-boundary.js
node test/test-commercial-contract-v1.js
git diff --check
git status --short
```

Expected: all PASS/check clean and no working-tree changes.

- [ ] **Step 15: Durable docs + Registry cleanup**

Revision-aware append C3 `VERIFIED / INTEGRATED` evidence to Roadmap & Work Log. Update Owner Presentation Highlights only with capabilities actually integrated: public Control Center host/open-core extension boundary and preserved human-control security model. Re-read Registry, delete only the C3 active block after exact merged-SHA verification + Work Log update, and verify M3B/M6/M8 entries remain intact.

- [ ] **Step 16: Final report**

Report docs read, starting/final SHA, Registry conflicts, Graphify fallback, RED→GREEN evidence, exact code/security boundaries, Codex result/limitations, focused/full/real-MCP verification, branch/commits/PR/CI, merge SHA, canonical status, `main`/upstream status, no deployment, docs cleanup, blockers and `0% remaining` only if every completion gate above is satisfied.

---

## Planned commit sequence

1. `feat: add Control Center contract v1`
2. `feat: add public Control Center host`
3. `feat: extract Pro Control Center extension`
4. `feat: extract Team Control Center extension`
5. `refactor: recompose prototype Control Center`
6. `test: prove public Control Center open-core boundary`
7. `docs: record Control Center extraction readiness`

Keep commits independently buildable/testable where practical; do not squash locally before review unless GitHub integration policy explicitly requires it.