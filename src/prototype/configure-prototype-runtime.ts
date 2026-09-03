import { configureRuntimeServices } from '../runtime/runtime-services.js';
import { PrototypeEntitlementProvider } from './prototype-entitlement-provider.js';
import { PrototypePolicyHook } from './prototype-policy-hook.js';

let configured = false;

export function configurePrototypeRuntime(): void {
    if (configured) {
        return;
    }

    configureRuntimeServices({
        entitlementProvider: new PrototypeEntitlementProvider(),
        policyHook: new PrototypePolicyHook(),
    });
    configured = true;
}
