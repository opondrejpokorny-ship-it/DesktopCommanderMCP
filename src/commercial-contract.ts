export const COMMERCIAL_CONTRACT_VERSION = 1 as const;

export {
    CapabilityRegistry,
} from './entitlements/capabilities.js';
export type {
    EntitlementProvider,
    EntitlementSnapshot,
} from './entitlements/capabilities.js';

export type {
    RuntimePolicyGateResult,
    RuntimePolicyHook,
} from './runtime/policy-hook.js';

export {
    configureRuntimeServices,
} from './runtime/runtime-services.js';
export type {
    RuntimeServices,
} from './runtime/runtime-services.js';
