# C3 — Public Control Center Host / Commercial Extension Boundary

Date: 2026-09-05
Status: architectural design approved in chat; written specification pending user review
Baseline: `prototype/free-pro-team` @ `f3b44e4734300a0f2482a6189bacb6c84f254a55`

## Goal

Split the current demo-monolithic local Control Center into a stable PUBLIC/shared host and trusted first-party extensions so future private Pro/Team code can compose above the public Desktop Commander core without deep-importing public `src/*` internals.

The product boundary remains:

- Free = access;
- Pro = user control over that access;
- Team = organizational/device governance and audit.

C3 is an architecture/composition boundary. It does not create production licensing, billing, hosted fleet control, a third-party plugin ecosystem, or a new authorization model.

## Current problem

`src/control-center/server.ts` currently combines multiple responsibilities in one ~988-line module:

- loopback HTTP host and session-token security;
- security headers and request/body helpers;
- inline HTML/CSS/JavaScript shell;
- Pro policy/profile/folder/command mutation;
- human approval listing and mutation;
- Team audit reading and Remote Device identity;
- prototype/demo tier mutation through `setPolicyTier()`.

The open-core boundary therefore still classifies all of `src/control-center` as `demo`. The current Free package proof correspondingly rejects all `dist/control-center/*`, because there is no public-only Control Center unit it can safely include.

C1 separately froze `@wonderwhy-er/desktop-commander/commercial-contract` at version 1. Its contract test intentionally forbids Control Center symbols, so C3 must not silently widen or mutate Commercial Contract v1.

C2 already removed the direct Pro policy-runtime dependency on Team audit storage. C3 is the next blocker before physical commercial extraction because the UI/control surface still composes public, Pro, Team and demo concerns directly.

## Architectural decision

Use one PUBLIC Control Center host with trusted server-side extension objects supplied explicitly by product composition:

```text
PUBLIC Control Center host
  ├─ PUBLIC/core extensions (for example future read-only Memory)
  ├─ Pro extension(s)
  ├─ Team extension(s)
  └─ demo-only extension(s)
```

Extensions are first-party application modules, not dynamically discovered third-party plugins. The browser, MCP client, filesystem and ordinary model-facing configuration cannot register or replace extensions.

Production composition supplies only extensions present in the installed product and allowed by the current entitlement. Prototype/demo composition may register all known extensions so the existing showcase can switch tiers without pretending that switch is production entitlement authority.

## Non-goals

C3 does not:

- split code into the final private `DesktopCommanderCommercial` repository;
- change C1 Commercial Contract v1;
- introduce signed entitlement verification or billing;
- create browser-loadable arbitrary plugins or filesystem extension discovery;
- change policy engine, exact-action approval or upstream safety semantics;
- change Operational Memory persistence/retrieval or M3B Global semantics;
- implement M6 Memory browsing itself;
- turn UI visibility into an authorization boundary;
- change `main` or deploy anything.

## PUBLIC host responsibilities

The public host owns the security envelope and shared lifecycle. Extensions do not receive the raw `http.Server`, `IncomingMessage` or `ServerResponse` objects.

The host owns:

1. loopback binding and allowed host names;
2. local Host-header validation;
3. per-session token generation and timing-safe verification;
4. `/api/*` token enforcement;
5. route registration, namespace ownership and duplicate/overlap rejection;
6. current entitlement lookup and capability gating;
7. local-origin enforcement for every non-GET extension route;
8. bounded request-body reading/parsing;
9. security headers, content types and final response serialization;
10. generic 404/400/500 handling without leaking paths, SQL or internal stack details;
11. neutral Control Center shell/navigation;
12. read-only entitlement/active-extension status;
13. extension ordering and activation/deactivation in the UI.

The host must preserve the existing loopback, token, CSP, no-store, frame-deny, referrer and same-origin protections unless a later independently reviewed security change strengthens them.

## Request security order

For extension API requests the intended order is:

```text
request
  -> local Host validation
  -> /api namespace check
  -> session-token verification
  -> extension/route lookup
  -> current entitlement + required capability check
  -> non-GET local-origin check
  -> bounded body/query parsing
  -> extension handler
  -> host-owned sanitized response serialization + security headers
```
A non-GET request is treated as a mutation for host-origin enforcement regardless of what an extension claims. GET handlers are contractually read-only.

Capability checks supplement policy/approval/upstream checks; they do not replace them. A capability can make an extension or route available, but cannot grant an execution ALLOW decision.

## New public Control Center contract

C3 adds a separate package subpath rather than widening C1:

`@wonderwhy-er/desktop-commander/control-center-contract`

with:

```ts
export const CONTROL_CENTER_CONTRACT_VERSION = 1 as const;
```

The contract is PUBLIC/shared and versioned independently from `COMMERCIAL_CONTRACT_VERSION`.

Its v1 surface should be intentionally narrow and contain only composition types and the public host start function needed by another package. It may import PUBLIC capability/entitlement types internally, but must not expose policy-store, approval-store, audit-store, prototype provider or demo implementation types.

Conceptual contract:

```ts
export type ControlCenterMethod = 'GET' | 'POST';

export interface ControlCenterRouteV1 {
  method: ControlCenterMethod;
  path: string;
  requiredCapabilities?: readonly Capability[];
  handle(context: ControlCenterRequestContextV1): Promise<ControlCenterJsonResponseV1>;
}

export interface ControlCenterRequestContextV1 {
  params: Readonly<Record<string, string>>;
  query: Readonly<Record<string, readonly string[]>>;
  entitlement: EntitlementSnapshot;
  readJsonBody(): Promise<unknown>;
}

export interface ControlCenterJsonResponseV1 {
  status: number;
  body: unknown;
}

export interface ControlCenterExtensionV1 {
  id: string;
  apiPrefixes: readonly `/api/${string}`[];
  requiredCapabilities?: readonly Capability[];
  routes: readonly ControlCenterRouteV1[];
  ui?: ControlCenterUiContributionV1;
}
```
The concrete v1 contract may refine names during TDD, but the following invariants are frozen by this design:

- handlers receive a host-created context, never raw Node HTTP response objects;
- extension APIs return JSON through host serialization;
- extensions own one or more explicit `/api/...` namespaces and cannot intercept core host routes;
- duplicate or overlapping extension namespaces fail startup rather than using order-dependent routing;
- extension-level and route-level capability requirements are declarative and host-enforced;
- non-GET routes always receive host local-origin enforcement;
- request body access is bounded by the host;
- route paths are relative to an owned namespace and support only static segments plus named single-segment :param placeholders; extension-supplied regular-expression routers are out of scope;
- extensions are supplied explicitly in `startControlCenter()` options/composition.

A likely host entry point is conceptually:

```ts
startControlCenter({
  entitlementProvider,
  extensions: [/* trusted first-party extension objects */],
});
```

If no provider is supplied by a public/Free composition, the host uses the public Free entitlement provider or requires the caller to supply an equivalent Free snapshot. It must never infer paid capability from UI state.

## Host state

The shared `/api/state` endpoint becomes host-neutral. It may expose only sanitized values needed by the shell, for example:

```ts
{
  generatedAt,
  entitlement: { source, tier, capabilities, expiresAt? },
  activeExtensions: [{ id, viewId?, label? }]
}
```

It must not aggregate paid policy, approval, Team audit/device or future Memory datasets into the global state poll.

This keeps the shell stable and prevents large or paid-specific state from becoming an accidental public contract.

## Entitlement evaluation

The host receives an `EntitlementProvider` and evaluates extension/route availability server-side. For C3 v1 the safe default is to obtain a fresh snapshot when serving protected extension state/mutations rather than trusting browser state or a startup-only tier decision.

An expired or capability-reduced snapshot makes the affected extension/route unavailable before its handler runs. Entitlement availability still does not authorize the underlying filesystem/process action; policy, approvals and upstream validation remain authoritative.
## UI contribution model

C3 does not build a general frontend plugin platform. The existing single local page remains one first-party application assembled at server startup.

The PUBLIC host owns:

- page document, base styles and CSP/security headers;
- navigation/view switcher;
- the authenticated `api()` browser helper;
- safe DOM utility patterns and common status/error presentation.

A trusted extension may contribute static first-party view markup plus client initialization code through a narrow `ControlCenterUiContributionV1` contract, conceptually:

```ts
interface ControlCenterUiContributionV1 {
  viewId: string;
  label: string;
  order?: number;
  bodyHtml: string;
  clientScript?: string;
}
```

These strings are product code shipped in the trusted extension package. They are not a channel for persisted/user/model text. Dynamic values returned by extension APIs must continue to be rendered with safe DOM APIs such as `.textContent`; arbitrary server data must not be assigned to `innerHTML`.

The host may expose a small browser bootstrap object such as `window.DCControlCenter` containing `api`, `createElement` and view lifecycle hooks. The helper attaches the session token so extension client code does not implement a parallel authentication path.

This is a packaging/composition boundary between trusted first-party modules, not a sandbox boundary between hostile plugins. Future external plugins would require a separate design.

## Pro extension responsibilities

The Pro commercial layer owns the current user-control features, including:

- policy profile selection;
- folder read/write/read-only/blocked/approval-required rules;
- command allow/block/approval rules;
- applicable process/config/workflow/external controls as those UIs are added;
- pending local approval presentation;
- human approve/deny mutation.

Pro extension routes are available only when their corresponding capabilities are present, for example `policy.config`, `policy.filesystem`, `policy.command` and `approvals.local`.

Human approval mutation remains a trusted Control Center operation outside the ordinary MCP/model-facing surface.
## Team extension responsibilities

Team adds capabilities above Pro rather than becoming a separate product fork. Team-owned Control Center surfaces include:

- Remote Device identity/state needed for device-scoped governance;
- per-device policy presentation/configuration where `team.device_policy` is required;
- local Team audit browsing where `audit.local` is required;
- future organization/fleet/shared-approval controls only when those capabilities actually exist.

Team audit/device implementation must not become a dependency required for Pro approvals. C2's Pro→Team storage decoupling remains an invariant.

## Demo-only extension

The existing prototype needs to keep a convenient Free/Pro/Team showcase, but `setPolicyTier()` must not become production entitlement authority.

Therefore C3 moves tier mutation behind a demo-only extension, conceptually under `/api/demo/*`. Only prototype/demo composition registers that extension.

A demo tier change:

1. mutates the prototype-only tier source;
2. returns a controlled response;
3. causes subsequent host entitlement checks to observe the new `PrototypeEntitlementProvider` snapshot;
4. lets the shell refresh which already-registered first-party extensions are active.

Production/Free/Commercial composition omits the demo extension entirely. The public Control Center contract does not export `setPolicyTier`, `PrototypeEntitlementProvider` or any equivalent tier-mutation hook.

## M6 Operational Memory compatibility

Operational Memory remains PUBLIC/shared architecture. C3 must not pull JSONL/SQLite persistence, ProjectId/RepositoryId scope or retrieval semantics into the commercial layer.

The approved M6 design remains valid through its dedicated read-only query layer:

```text
Memory UI
  -> /api/memory/*
  -> operational-memory-query.ts
  -> existing read-only SQLite indexes + server-owned metadata
```

After C3, M6 attaches that UI/API through a PUBLIC read-only Control Center extension instead of adding four routes and Memory markup directly to a monolithic `server.ts`.

M6's query module, privacy rules, keyset pagination, 100k-event gate and M3B safe-Global semantics remain unchanged. M6 runtime work still waits for M3B integration/coordination as already recorded in the Active Work Registry.
## Target source ownership

A likely source layout is:

```text
src/control-center/
  contract.ts                 PUBLIC
  host.ts                     PUBLIC
  shell.ts                    PUBLIC
  extensions/
    pro-control.ts            PRO
    team-control.ts           TEAM
    demo-tier.ts              DEMO
src/prototype/
  control-center-composition.ts  DEMO
src/npm-scripts/control-center.ts DEMO/prototype launcher initially
```

Exact filenames may change during implementation, but ownership may not collapse back into one demo module.

`open-core-boundaries.json` should classify the host/contract/shell as PUBLIC, Pro extensions as Pro, Team extensions as Team and prototype composition/demo tier switching as demo.

The public host must import only PUBLIC/shared source. It cannot import policy runtime/stores, prototype providers, audit/device stores or commercial extension factories.

## API namespace ownership

The host reserves its own neutral routes such as `/api/state`. Every extension declares explicit namespace ownership. The implementation should prefer clear roots such as:

- `/api/pro/*` for Pro policy/approval UI operations;
- `/api/team/*` for Team device/audit operations;
- `/api/demo/*` for prototype-only tier switching;
- `/api/memory/*` for the future PUBLIC M6 read-only extension.

The exact internal URLs may preserve a small compatibility alias where useful for the current prototype, but existing local prototype endpoints are not promoted into a new public cross-repo compatibility contract merely by C3.

No extension may claim `/`, `/favicon.ico`, `/api/state`, another extension's namespace, or a parent prefix that would shadow another registered extension. Startup fails closed on namespace collision.

## Free/open-core packaging proof

The current Free proof forbids all `dist/control-center/*` because the directory is entirely demo-owned. After C3 that assertion becomes more precise.

The Free artifact must contain the PUBLIC Control Center host/contract/shell needed to clean-install and start a Free-only local Control Center, and must physically omit:

- Pro Control Center extension implementation;
- Team Control Center extension implementation;
- demo tier extension/composition;
- policy/approval stores and runtime implementation already excluded by the Free proof;
- Team audit/device stores already excluded by the Free proof.

A clean-installed Free proof must import the versioned Control Center contract and start the PUBLIC host with zero paid/demo extensions. The resulting page and neutral `/api/state` must work without resolving any paid module.

C1 Commercial Contract v1 remains unchanged and its existing test must continue to prove that `control-center` does not leak into that declaration surface.

C3 adds its own package export and focused contract test. The runtime export whitelist should stay minimal, for example only `CONTROL_CENTER_CONTRACT_VERSION` plus the public host start/composition entry point; the rest should be types.

## Migration sequence

Implementation should avoid a flag-day rewrite of all behavior.

1. Add the PUBLIC contract/host with no paid imports and focused security tests.
2. Move existing shared host/security helpers into that host while preserving current behavior.
3. Extract Pro policy/approval routes and UI into trusted Pro extension modules.
4. Extract Team audit/device routes and UI into Team extension modules.
5. Move prototype tier mutation into the demo-only extension/composition.
6. Recompose the current prototype launcher from PUBLIC host + Pro + Team + demo extensions.
7. Update open-core classification and Free artifact proof.
8. Run the existing Control Center behavior/security suite against the recomposed prototype.

At each step the prototype should remain runnable; no intermediate commit should require public host code to import commercial implementation.

## Security and privacy invariants

C3 must preserve or strengthen all existing security properties:

- loopback-only default binding;
- local Host-header validation;
- per-session Control Center token on every `/api/*` request;
- timing-safe token comparison;
- local-origin validation before every non-GET handler;
- bounded request bodies;
- host-owned security headers and response serialization;
- no raw file contents or raw terminal commands in approval/audit responses;
- no model-facing approval mutation tool;
- exact-action/fingerprint/expiry/one-time approval semantics unchanged;
- capability gating before extension handlers;
- policy/approval/upstream validation still authoritative after capability checks;
- no browser/UI state treated as authorization;
- no ordinary MCP/config path able to register a privileged extension.

A missing/expired capability must prevent the affected route handler from running. An extension handler must never be able to consume an approval or mutate policy before the host has completed token/origin/capability checks.

C3 is not a complete security sandbox. Trusted commercial extensions still run in the same process and must be reviewed as trusted product code.

## Error behavior

Host-level errors are controlled and bounded:

- invalid Host → 400;
- missing/invalid session token → 403;
- inactive/unregistered extension or route → 404;
- invalid mutation origin → 403;
- malformed/oversized request body → 400/413-style controlled response;
- extension-declared validation failure → controlled 400 response;
- unexpected handler failure → generic 500 without stack/path/internal implementation detail.

Extension code may return only the documented structured response type. It must not write directly to the socket or alter host security headers.

## RED → GREEN verification strategy

Implementation should establish focused REDs before refactoring production behavior.
Expected RED coverage:

1. PUBLIC host/contract cannot yet be imported without demo Control Center coupling.
2. PUBLIC host ownership cannot yet pass open-core classification while `src/control-center` is demo-owned.
3. Free artifact cannot yet include a public Control Center unit while excluding paid extensions.
4. Pro policy/approval behavior is still directly embedded in the monolithic server.
5. Team audit/device behavior is still directly embedded in the monolithic server.
6. prototype tier mutation is still mixed with normal policy routes.
7. extension namespace collision/capability/origin guarantees do not yet exist as reusable host tests.

GREEN verification must include:

- focused public host/contract tests;
- startup rejection for duplicate/overlapping/reserved extension namespaces;
- unauthenticated extension request denial;
- missing-capability handler non-execution proof;
- non-GET invalid-origin handler non-execution proof;
- bounded malformed/oversized body negatives;
- Pro policy/profile/folder/command behavior regressions;
- exact-action approval list/approve/deny and one-time lifecycle regressions;
- Team audit/device behavior and Pro-without-Team negative proof;
- demo tier switching proof without exporting tier mutation in production contract;
- Control Center page/header/CSP/no-store regressions;
- open-core source-boundary guard;
- Commercial Contract v1 unchanged whitelist test;
- new Control Center Contract v1 whitelist/declaration test;
- real Free artifact build/clean-install proof excluding paid extensions;
- build/typecheck and `git diff --check`;
- full regression suite with baseline-only failures reproduced on exact baseline;
- PR/CI and exact merged-SHA verification.
## Acceptance criteria

C3 is complete only when all of the following are true:

- PUBLIC Control Center host/contract/shell import only PUBLIC/shared code;
- private/commercial code can compose trusted extensions through a versioned public package surface without deep-importing `src/*`;
- C1 Commercial Contract v1 remains byte/behavior compatible at its tested export surface;
- Pro policy/approval code no longer lives in or is imported by the PUBLIC host;
- Team audit/device code no longer lives in or is imported by the PUBLIC host or Pro-only extension;
- prototype tier mutation exists only in demo composition/extension;
- host enforces token, capability and non-GET origin checks before extension handlers;
- extensions cannot write raw HTTP responses or override host security headers;
- current Pro/Team/demo Control Center behavior is preserved through recomposition;
- the clean-installed Free proof imports the Control Center contract, starts the PUBLIC host with zero paid/demo extensions, and excludes paid/demo extension implementation;
- M6 has a documented PUBLIC read-only extension target without changing its memory query/persistence semantics;
- open-core guard, focused security tests, broader regressions, PR/CI and exact merged-SHA verification pass;
- Work Log/Owner Presentation Highlights are updated only after authoritative integration and verification;
- Active Work Registry is cleaned only after those completion gates.

## Implementation boundary with physical extraction

C3 stops before creating the final private repository. Once C1, C2 and C3 are integrated and verified, C4 may create `DesktopCommanderCommercial` and consume only pinned/versioned public package contracts.

The private repository should then own Pro + Team extensions/commercial implementation while the public repository retains the Free/shared host, runtime, Scope/Workflow/Operational Memory and public contracts.

Repository ownership still does not grant runtime authorization. Entitlements decide feature availability; policy decides allowed actions; exact-action approvals gate protected retries; upstream Desktop Commander validation always remains in force.

## Deployment

No deployment is part of C3 design or implementation unless explicitly authorized by the user after integration. A source/CI-complete C3 change may therefore finish with `deployment: not performed / not authorized`.
