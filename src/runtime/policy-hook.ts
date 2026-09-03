import type { ServerResult } from '../types.js';
import type { CapabilityRegistry } from '../entitlements/capabilities.js';

export type RuntimePolicyDecision = 'allow' | 'deny' | 'require_approval';

export interface RuntimePolicyGateResult {
    allowed: boolean;
    decision: RuntimePolicyDecision;
    result?: ServerResult;
    opaqueContext?: unknown;
}

export interface RuntimePolicyHook {
    preflight(
        tool: string,
        args: unknown,
        capabilities: CapabilityRegistry,
    ): Promise<RuntimePolicyGateResult>;

    recordExecution?(
        gate: RuntimePolicyGateResult,
        tool: string,
        outcome: 'success' | 'failure',
        durationMs: number,
    ): Promise<void>;
}

export class NoopPolicyHook implements RuntimePolicyHook {
    async preflight(): Promise<RuntimePolicyGateResult> {
        return {
            allowed: true,
            decision: 'allow',
        };
    }
}
