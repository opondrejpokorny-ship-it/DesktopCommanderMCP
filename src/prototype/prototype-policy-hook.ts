import type { Capability, CapabilityRegistry } from '../entitlements/capabilities.js';
import { FileAuditSink } from '../policy/audit-store.js';
import {
    applyPolicyGate,
    recordPolicyExecutionResult,
    type PolicyGateResult,
} from '../policy/policy-gate.js';
import {
    normalizeToolActions,
    type NormalizedToolAction,
} from '../policy/tool-policy.js';
import type {
    RuntimePolicyGateResult,
    RuntimePolicyHook,
} from '../runtime/policy-hook.js';

const ACTION_CAPABILITY: Record<NormalizedToolAction['action'], Capability> = {
    'filesystem.read': 'policy.filesystem',
    'filesystem.write': 'policy.filesystem',
    'filesystem.move': 'policy.filesystem',
    'filesystem.delete': 'policy.filesystem',
    'terminal.execute': 'policy.command',
    'process.terminate': 'policy.process',
    'config.change': 'policy.config',
    'workflow.change': 'policy.workflow',
    'external.open': 'policy.external',
};

function shouldEvaluateCommercialPolicy(
    tool: string,
    args: unknown,
    capabilities: CapabilityRegistry,
): boolean {
    return normalizeToolActions(tool, args).some(
        (action) => capabilities.has(ACTION_CAPABILITY[action.action]),
    );
}

function asRuntimeGate(gate: PolicyGateResult): RuntimePolicyGateResult {
    return {
        allowed: gate.allowed,
        decision: gate.decision,
        ...(gate.result ? { result: gate.result } : {}),
        opaqueContext: gate,
    };
}

export class PrototypePolicyHook implements RuntimePolicyHook {
    async preflight(
        tool: string,
        args: unknown,
        capabilities: CapabilityRegistry,
    ): Promise<RuntimePolicyGateResult> {
        if (!shouldEvaluateCommercialPolicy(tool, args, capabilities)) {
            return {
                allowed: true,
                decision: 'allow',
            };
        }

        const auditSink = capabilities.has('audit.local')
            ? new FileAuditSink()
            : undefined;
        const gate = await applyPolicyGate(
            tool,
            args,
            undefined,
            undefined,
            undefined,
            {
                allowDeviceScope: capabilities.has('team.device_policy'),
                auditEnabled: !!auditSink,
                auditSink,
            },
        );
        return asRuntimeGate(gate);
    }

    async recordExecution(
        gate: RuntimePolicyGateResult,
        tool: string,
        outcome: 'success' | 'failure',
        durationMs: number,
    ): Promise<void> {
        const internal = gate.opaqueContext as PolicyGateResult | undefined;
        if (!internal) {
            return;
        }
        await recordPolicyExecutionResult(
            internal,
            tool,
            outcome,
            durationMs,
        );
    }
}
