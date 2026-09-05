# Open-Core Physical Extraction Readiness

Status: readiness contract; no physical repository split yet.
Baseline: `prototype/free-pro-team` @ `f3b44e4734300a0f2482a6189bacb6c84f254a55` (C3 starting authority).

## Decision
Use two product repositories, not three forks:

```text
wonderwhy-er/DesktopCommanderMCP
          ↓ upstream sync once
PUBLIC DesktopCommanderMCP Free/shared core
          ↓ pinned tag/SHA + versioned contracts
PRIVATE DesktopCommanderCommercial
          ├── Pro
          └── Team
```

A separate Team service is justified only when central fleet/account functionality actually needs a hosted authority.

## Non-goals of this slice
No commercial code is physically moved to a private repository. C3 does not change MCP execution policy/approval semantics, entitlement signing, billing, DRM, Scope Architecture, Operational Memory persistence/retrieval, or deployment. It refactors the local Control Center composition and Free packaging proof only.
## Current ownership inventory

The machine-readable authority for this readiness slice is `open-core-boundaries.json`. Every `src/**/*.ts` file is classified: the default is `public`, with explicit non-public overrides.

| Area | Current owner | Extraction meaning |
| --- | --- | --- |
| `src/entitlements/*` | PUBLIC/shared | Capability/entitlement contracts plus Free provider |
| `src/runtime/policy-hook.ts` | PUBLIC/shared | Stable attachment point; Free uses no-op behavior |
| `src/runtime/runtime-services.ts` | PUBLIC/shared | Shared runtime composition surface |
| `src/free-index.ts`, `src/run-server.ts`, `src/server.ts` | PUBLIC/shared | Free/shared execution composition |
| `src/workflow/*`, `src/progress/*` | PUBLIC/shared | General workflow/memory/progress infrastructure; paid presentation can gate individual capabilities |
| `src/policy/*` | Pro/commercial by default | Commercial governance implementation; Team-only audit/device storage remains separately classified |
| `src/policy/audit-store.ts` | Team | Team/local audit storage candidate |
| `src/policy/device-identity.ts` | Team | Device-scoped governance candidate |
| `src/prototype/*` | demo-only | Prototype entitlement/policy/audit composition |
| `src/index.ts` | demo-only | Current prototype/commercial entrypoint |
| `src/control-center/contract.ts`, `host.ts`, `src/control-center-contract.ts` | PUBLIC/shared | Versioned Control Center Contract v1 plus loopback host/security envelope |
| `src/control-center/pro-extension.ts` | Pro | Policy/profile/folder/command controls and local approval UI/mutation |
| `src/control-center/team-extension.ts` | Team | Remote Device selection and privacy-bounded audit UI/API |
| `src/control-center/demo-extension.ts`, `server.ts` | demo-only | Local tier switch plus prototype composition of PUBLIC + Pro + Team extensions |
| `src/npm-scripts/access-control.ts` | demo-only today | Uses prototype audit composition |
| `src/npm-scripts/control-center.ts` | demo-only today | Starts current prototype Control Center |

The Pro/Team labels are product inventory, not a requirement for separate private repositories. Pro and Team intentionally target one commercial repository, so internal commercial dependencies can be resolved there before a future production packaging decision.
## Permanent dependency invariant

The new source-level guard enforces the rule that matters before physical extraction:

> PUBLIC/shared source may import only PUBLIC/shared source.

This complements, rather than replaces, the existing Free package proof. The package proof verifies emitted reality; the source guard prevents a future shared module from quietly acquiring a commercial dependency before packaging.

Commercial and demo code may depend on public contracts. Pro must not depend on Team-only implementation; Team may build on Pro. The current demo composition may depend on all layers.

## Current finding: Control Center boundary is split for extraction

C2 removed the Pro -> Team storage dependency from policy runtime. C3 now separates the Control Center itself: the PUBLIC/shared host owns loopback binding, Host/token/origin checks, namespace registration, capability/expiry gating, request parsing, neutral state and trusted UI composition; Pro owns policy/approval controls; Team owns device/audit controls; demo-only code owns local tier mutation and prototype composition.

The PUBLIC host fails closed before extension handlers when capabilities are absent, expired or incomplete. Human approval mutation remains outside the ordinary model MCP surface, and existing policy/approval/upstream safeguards are unchanged. Pro does not import Team audit/device implementation. The Free package roots and exports the PUBLIC Control Center contract/host while physically omitting Pro, Team, demo and prototype/policy implementation.

This removes the Control Center monolith as a physical-extraction blocker, but it does not create the final private `DesktopCommanderCommercial` repository or a production entitlement authority. Future commercial composition must consume only versioned public package contracts rather than deep-importing public `src/*`.

## Public cross-repo contract

The future commercial repository should consume only versioned public attachment points. The current required public set is:

- `EntitlementProvider`, entitlement snapshot and `CapabilityRegistry` in `src/entitlements/capabilities.ts`;
- `FreeEntitlementProvider` as the public default;
- `RuntimePolicyHook` / no-op policy boundary;
- runtime service composition;
- shared server startup and Free entrypoint;
- `@wonderwhy-er/desktop-commander/commercial-contract` remains the separately frozen C1 v1 commercial attachment contract;
- `@wonderwhy-er/desktop-commander/control-center-contract` is the separately versioned C3 v1 public Control Center host/extension attachment contract.

C1 and C3 therefore have explicit package/export surfaces. Future commercial code must consume those versioned package contracts rather than reaching back into arbitrary public-core `src/*` internals.

## Commercial build/version contract

A commercial release should identify the exact public core it was built and tested against, for example:

```text
DesktopCommanderCommercial 1.0.0
coreVersion: 0.3.x
coreSourceSha: <exact public SHA>
contractVersion: 1
```

Commercial CI should obtain that pinned public revision, compose the private Pro/Team implementation above it, then run Free + Pro + Team regression/security proofs. A moving public branch must not be the reproducibility boundary for a commercial release.

## Upstream update flow

Upstream is integrated once:

1. update the public `main` mirror from `wonderwhy-er/DesktopCommanderMCP`;
2. integrate/reconcile the public Free/shared product branch and run public/core proofs;
3. tag or otherwise pin the verified public core revision;
4. make Commercial CI test its private head against that exact public revision;
5. release commercial only after the combined proof is green.

This avoids maintaining Free, Pro and Team as three divergent Desktop Commander forks.
## Physical split exit gates

Do not create the final private commercial repository until all of these are true:

1. Free remains independently buildable/installable and real MCP read/write smoke is green.
2. The source boundary guard is green and PUBLIC has no direct commercial/demo imports.
3. Public cross-repo contracts have an explicit version/compatibility policy.
4. Commercial composition can be tested against a pinned public core revision.
5. Pro approvals are not accidentally dependent on Team-only storage/hosted services.
6. Scope B1/B2 shared identities are stable enough that extraction will not immediately churn the cross-repo API.
7. Operational Memory shared/public storage contracts needed by both distributions are stable.
8. Independent public and combined commercial CI is rehearsed.
9. MIT/upstream attribution and public/private licensing boundaries are documented.

## Disclosure boundary

The current prototype branch has already existed in a public repository. Moving implementation to a private repository later does not make already-published history secret. Treat the current code as disclosed showcase/reference material and protect future proprietary development prospectively.

## Security and product boundaries

Repository ownership is not execution authorization. Public/project/scope metadata must never bypass policy, exact-action approvals or upstream Desktop Commander validation. Signed/server-verified entitlement and licensing remain a later production layer; the current local prototype tier selector must not become that authority.

## Scope Architecture and Operational Memory

Scope primitives, Project/Repository/Task infrastructure and the Operational Memory engine remain PUBLIC/shared architecture by default. Their data must still respect project/device scope and privacy. A future paid capability may expose richer UI/administration, but the core data-scope mechanism should not become entangled with commercial policy enforcement merely because Pro/Team consume it.

M6 remains a future PUBLIC read-only Control Center extension target. It may use this host/extension contract later, but it must not become authorization or move Operational Memory authority into commercial code.
