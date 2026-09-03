import {
    CapabilityRegistry,
    EntitlementProvider,
    EntitlementSnapshot,
} from '../entitlements/capabilities.js';
import { FreeEntitlementProvider } from '../entitlements/free-provider.js';
import {
    NoopPolicyHook,
    RuntimePolicyHook,
} from './policy-hook.js';

export interface RuntimeServices {
    entitlementProvider: EntitlementProvider;
    policyHook: RuntimePolicyHook;
}

export interface RuntimeAccess {
    entitlement: EntitlementSnapshot;
    capabilities: CapabilityRegistry;
}

function defaultRuntimeServices(): RuntimeServices {
    return {
        entitlementProvider: new FreeEntitlementProvider(),
        policyHook: new NoopPolicyHook(),
    };
}

let runtimeServices: RuntimeServices = defaultRuntimeServices();

export function configureRuntimeServices(
    next: Partial<RuntimeServices>,
): RuntimeServices {
    runtimeServices = {
        ...runtimeServices,
        ...next,
    };
    return runtimeServices;
}

export function getRuntimeServices(): RuntimeServices {
    return runtimeServices;
}

export async function resolveRuntimeAccess(): Promise<RuntimeAccess> {
    const entitlement = await runtimeServices.entitlementProvider.getEntitlement();
    return {
        entitlement,
        capabilities: new CapabilityRegistry(entitlement.capabilities),
    };
}

export function resetRuntimeServicesForTests(): void {
    runtimeServices = defaultRuntimeServices();
}
