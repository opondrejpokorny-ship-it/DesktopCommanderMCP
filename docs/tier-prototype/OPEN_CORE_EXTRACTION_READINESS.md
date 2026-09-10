# Open-Core Physical Extraction Readiness

Status: R3.5 physical public-source extraction implemented on `feat/r3-public-paid-source-removal`; public PR/CI/merge is still pending.
R3.5 baseline: `prototype/free-pro-team` @ `0eda352feeeca4303ee90e8bedd1e35f1e55eaf8`. Private Commercial R3.4 is already merged and post-merge verified at `fe87d99cb6706b9d088ff0370839086c4c7456aa`.

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

## Scope and non-goals of this slice
R3.5 removes active paid implementation from the public source tree after verified private Commercial parity. It does not introduce production entitlement signing, billing, DRM, hosted Team authority, deployment, or a complete security sandbox. Shared Scope/Workflow/Operational Memory infrastructure remains public.
## Current ownership inventory

The machine-readable authority is `open-core-boundaries.json`. In the R3.5 branch, active `src/**/*.ts` is public/shared; paid implementation is physically absent.

| Area | R3.5 owner | Extraction meaning |
| --- | --- | --- |
| `src/entitlements/*` | PUBLIC/shared | Capability contracts plus Free provider; Free does not grant paid capabilities |
| `src/runtime/policy-hook.ts`, `runtime-services.ts` | PUBLIC/shared | Stable Commercial attachment point; Free uses no-op policy |
| `src/index.ts`, `src/free-index.ts`, `src/run-server.ts`, `src/server.ts` | PUBLIC/shared | Free/default execution composition |
| `src/workflow/*`, `src/progress/*` | PUBLIC/shared | Workflow, Active Work, progress and Operational Memory infrastructure |
| `src/control-center/contract.ts`, `host.ts`, `src/control-center-contract.ts` | PUBLIC/shared | Control Center Contract v1 and security envelope |
| `src/control-center/server.ts` | PUBLIC/shared | Free Control Center composition: Memory + Usage |
| `src/policy/*`, `src/prototype/*` | PRIVATE Commercial / historical public Git only | Not present in active R3.5 public source |
| Pro/Team/demo Control Center extensions | PRIVATE Commercial / historical public Git only | Not present in active R3.5 public source |
| `src/npm-scripts/access-control.ts` | PRIVATE/demo historical | Not present in active R3.5 public source |

Paid behavior remains verified in the private Commercial repository rather than by keeping duplicate active implementation in the public repository.
## Permanent dependency invariant

The new source-level guard enforces the rule that matters before physical extraction:

> PUBLIC/shared source may import only PUBLIC/shared source.

This complements, rather than replaces, the existing Free package proof. The package proof verifies emitted reality; the source guard prevents a future shared module from quietly acquiring a commercial dependency before packaging.

Commercial and demo code may depend on public contracts. Pro must not depend on Team-only implementation; Team may build on Pro. The current demo composition may depend on all layers.

## Current finding: Control Center boundary is split for extraction

C2 removed the Pro -> Team storage dependency from policy runtime. C3 now separates the Control Center itself: the PUBLIC/shared host owns loopback binding, Host/token/origin checks, namespace registration, capability/expiry gating, request parsing, neutral state and trusted UI composition; Pro owns policy/approval controls; Team owns device/audit controls; demo-only code owns local tier mutation and prototype composition.

The PUBLIC host fails closed before extension handlers when capabilities are absent, expired or incomplete. Human approval mutation remains outside the ordinary model MCP surface, and existing policy/approval/upstream safeguards are unchanged. Pro does not import Team audit/device implementation. The Free package roots and exports the PUBLIC Control Center contract/host while physically omitting Pro, Team, demo and prototype/policy implementation.

The Control Center monolith is no longer a physical-extraction blocker. The private Commercial repository now exists and its R3.4 parity is merged/verified; it composes against pinned public artifacts/contracts. A production entitlement authority remains future work, and Commercial must continue to consume only versioned public package contracts rather than arbitrary public `src/*` deep imports.

## Public cross-repo contract

The Commercial repository consumes only versioned public attachment points. The current required public set is:

- `EntitlementProvider`, entitlement snapshot and `CapabilityRegistry` in `src/entitlements/capabilities.ts`;
- `FreeEntitlementProvider` as the public default;
- `RuntimePolicyHook` / no-op policy boundary;
- runtime service composition;
- shared server startup and Free entrypoint;
- `@wonderwhy-er/desktop-commander/commercial-contract` remains the separately frozen C1 v1 commercial attachment contract;
- `@wonderwhy-er/desktop-commander/control-center-contract` is the separately versioned C3 v1 public Control Center host/extension attachment contract.

C1 and C3 therefore have explicit package/export surfaces. Commercial code must continue to consume those versioned package contracts rather than reaching back into arbitrary public-core `src/*` internals.

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
## R3.5 public extraction exit gates

Before merging R3.5 into `prototype/free-pro-team`, all of these must be true:

1. Free independently builds, installs and passes real MCP read/write/shared-safety proofs.
2. Active public source and normal build output contain no paid policy/prototype/Pro/Team/demo implementation.
3. Public Commercial Contract v1 and Control Center Contract v1 declaration/package boundaries are closed and versioned.
4. Public CI invokes only Free/shared-core tests; paid parity remains gated in private Commercial CI.
5. The standard build removes stale paid `dist` output left by an older prototype checkout.
6. Free Active Work, progress, workflow core-safety, allowed-directory, blocked-command and symlink safeguards remain authoritative.
7. The private Commercial product remains reproducible against an exact pinned public SHA/artifact digest and does not deep-import arbitrary public internals.
8. Public PR exact-head CI and merged-SHA CI are green before R3.5 is called integrated.
9. After public merge, Commercial is repinned to the final Free SHA/digest and the dual-product clean-checkout proof is rerun.

MIT/upstream attribution remains required in both products.

## Disclosure boundary

The current prototype branch has already existed in a public repository. Moving implementation to a private repository later does not make already-published history secret. Treat the current code as disclosed showcase/reference material and protect future proprietary development prospectively.

## Security and product boundaries

Repository ownership is not execution authorization. Public/project/scope metadata must never bypass policy, exact-action approvals or upstream Desktop Commander validation. Signed/server-verified entitlement and licensing remain a later production layer; the current local prototype tier selector must not become that authority.

## Scope Architecture and Operational Memory

Scope primitives, Project/Repository/Task infrastructure and the Operational Memory engine remain PUBLIC/shared architecture by default. Their data must still respect project/device scope and privacy. A future paid capability may expose richer UI/administration, but the core data-scope mechanism should not become entangled with commercial policy enforcement merely because Pro/Team consume it.

M6 remains a future PUBLIC read-only Control Center extension target. It may use this host/extension contract later, but it must not become authorization or move Operational Memory authority into commercial code.
