import {
    EntitlementProvider,
    EntitlementSnapshot,
    FREE_CAPABILITIES,
} from './capabilities.js';

export class FreeEntitlementProvider implements EntitlementProvider {
    async getEntitlement(): Promise<EntitlementSnapshot> {
        return {
            source: 'free-default',
            tier: 'free',
            capabilities: FREE_CAPABILITIES,
        };
    }
}
