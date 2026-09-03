export type ProductTier = 'free' | 'pro' | 'team';

export type Capability =
    | 'core.mcp'
    | 'usage.free_allowance'
    | 'policy.filesystem'
    | 'policy.command'
    | 'policy.process'
    | 'policy.config'
    | 'policy.workflow'
    | 'policy.external'
    | 'approvals.local'
    | 'audit.local'
    | 'progress.eta'
    | 'team.device_policy';

export interface EntitlementSnapshot {
    source: 'free-default' | 'prototype' | 'signed';
    tier: ProductTier;
    capabilities: readonly Capability[];
    expiresAt?: string;
}

export interface EntitlementProvider {
    getEntitlement(): Promise<EntitlementSnapshot>;
}

export const FREE_CAPABILITIES: readonly Capability[] = Object.freeze([
    'core.mcp',
    'usage.free_allowance',
]);

export class CapabilityRegistry {
    private readonly values: ReadonlySet<Capability>;

    constructor(capabilities: Iterable<Capability>) {
        this.values = new Set(capabilities);
    }

    has(capability: Capability): boolean {
        return this.values.has(capability);
    }

    require(capability: Capability): void {
        if (!this.has(capability)) {
            throw new Error(
                `Capability ${capability} is not available for this entitlement`,
            );
        }
    }

    list(): readonly Capability[] {
        return Object.freeze([...this.values]);
    }
}
