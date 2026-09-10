import type { CapabilityRegistry } from '../entitlements/capabilities.js';

export type RuntimePolicyDecision = 'allow' | 'deny' | 'require_approval';

interface RuntimePolicyResultContent {
    type: string;
    text?: string;
    data?: string;
    mimeType?: string;
}

interface RuntimePolicyResult {
    content: RuntimePolicyResultContent[];
    isError?: boolean;
}

interface RuntimePolicyAllowResult {
    allowed: true;
    decision: 'allow';
    result?: never;
    opaqueContext?: unknown;
}

interface RuntimePolicyBlockedResult {
    allowed: false;
    decision: 'deny' | 'require_approval';
    result: RuntimePolicyResult;
    opaqueContext?: unknown;
}

export type RuntimePolicyGateResult = RuntimePolicyAllowResult | RuntimePolicyBlockedResult;

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
