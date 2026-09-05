# Open-Core Physical Extraction Readiness

Status: readiness contract; no physical repository split yet.
Baseline: `prototype/free-pro-team` @ `6aa1eb7ceff2ff4b12c8bc2e4ddc51c2cf0cc295`.

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
No commercial code is moved. No policy, approval, entitlement, workflow, Operational Memory, Scope Architecture or runtime behavior changes. No signed licensing, billing, private distribution, deployment or prototype→main merge is introduced here.
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
| `src/control-center/*` | demo-only today | Current UI is coupled to prototype composition; not production commercial authority |
| `src/npm-scripts/access-control.ts` | demo-only today | Uses prototype audit composition |
| `src/npm-scripts/control-center.ts` | demo-only today | Starts current prototype Control Center |

The Pro/Team labels are product inventory, not a requirement for separate private repositories. Pro and Team intentionally target one commercial repository, so internal commercial dependencies can be resolved there before a future production packaging decision.
## Permanent dependency invariant

The new source-level guard enforces the rule that matters before physical extraction:

> PUBLIC/shared source may import only PUBLIC/shared source.

This complements, rather than replaces, the existing Free package proof. The package proof verifies emitted reality; the source guard prevents a future shared module from quietly acquiring a commercial dependency before packaging.

Commercial and demo code may depend on public contracts. Pro must not depend on Team-only implementation; Team may build on Pro. The current demo composition may depend on all layers.

## Current finding: Control Center is demo composition

C2 removed the Pro -> Team storage dependency from `src/policy/policy-runtime.ts`: Pro now protects its policy/approval resources plus any explicitly environment-declared audit resource, while composition can inject additional protected commercial resources. The demo Team composition injects its audit path when `audit.local` is present, preserving audit-file tamper protection without making Pro runtime depend on Team storage. `policy-runtime.ts` and `policy-gate.ts` are therefore classified as Pro. The remaining extraction blocker in this area is the demo Control Center/access-control wiring through `prototype-audit-sink`.

The later extraction should provide commercial wiring that depends on commercial services/contracts rather than a `Prototype*` provider. This readiness slice deliberately records that requirement instead of changing the runtime while Scope/Memory foundation work is active.

## Public cross-repo contract

The future commercial repository should consume only versioned public attachment points. The current required public set is:

- `EntitlementProvider`, entitlement snapshot and `CapabilityRegistry` in `src/entitlements/capabilities.ts`;
- `FreeEntitlementProvider` as the public default;
- `RuntimePolicyHook` / no-op policy boundary;
- runtime service composition;
- shared server startup and Free entrypoint.
Before a physical split, these contracts should get an explicit package/export surface and compatibility version. Commercial code must not reach back into arbitrary public-core internals by relative path.

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
