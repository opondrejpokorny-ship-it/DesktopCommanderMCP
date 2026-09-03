import type {
    Capability,
    EntitlementProvider,
    EntitlementSnapshot,
    ProductTier,
} from '../entitlements/capabilities.js';
import { FREE_CAPABILITIES } from '../entitlements/capabilities.js';
import {
    loadPolicyRuntimeConfig,
    type PolicyRuntimeConfig,
} from '../policy/policy-runtime.js';

const PRO_CAPABILITIES: readonly Capability[] = Object.freeze([
    ...FREE_CAPABILITIES,
    'policy.filesystem',
    'policy.command',
    'policy.process',
    'policy.config',
    'policy.workflow',
    'policy.external',
    'approvals.local',
    'progress.eta',
]);

const TEAM_CAPABILITIES: readonly Capability[] = Object.freeze([
    ...PRO_CAPABILITIES,
    'audit.local',
    'team.device_policy',
]);

export type PrototypePolicyLoader = () => Promise<Pick<PolicyRuntimeConfig, 'tier'>>;

function capabilitiesForTier(tier: ProductTier): readonly Capability[] {
    switch (tier) {
        case 'free':
            return FREE_CAPABILITIES;
        case 'pro':
            return PRO_CAPABILITIES;
        case 'team':
            return TEAM_CAPABILITIES;
    }
}

export class PrototypeEntitlementProvider implements EntitlementProvider {
    constructor(
        private readonly loadPolicy: PrototypePolicyLoader =
            () => loadPolicyRuntimeConfig(),
    ) {}

    async getEntitlement(): Promise<EntitlementSnapshot> {
        const policy = await this.loadPolicy();
        return {
            source: 'prototype',
            tier: policy.tier,
            capabilities: capabilitiesForTier(policy.tier),
        };
    }
}
