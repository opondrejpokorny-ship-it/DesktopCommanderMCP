import { ServerResult } from '../types.js';
import { createPendingApproval, consumeApprovedAction } from './approval-store.js';
import { preflightToolRequest } from './policy-runtime.js';
import { normalizeToolAction } from './tool-policy.js';
import { PolicyDecision } from './types.js';

export interface PolicyGateResult {
    allowed: boolean;
    decision: PolicyDecision;
    matchedRuleId?: string;
    result?: ServerResult;
}

function policyResult(text: string): ServerResult {
    return {
        content: [{ type: 'text', text }],
        isError: true,
    };
}

/**
 * Apply prototype policy before an MCP tool reaches its existing handler.
 *
 * This does not replace Desktop Commander's existing filesystem/command
 * validation. ALLOW means "continue to the normal handler", not "skip existing
 * safety checks".
 */
export async function applyPolicyGate(
    tool: string,
    args: unknown,
    policyPath?: string,
    approvalPath?: string,
): Promise<PolicyGateResult> {
    try {
        const evaluation = await preflightToolRequest(tool, args, policyPath);

        if (evaluation.decision === 'allow') {
            return {
                allowed: true,
                decision: 'allow',
                matchedRuleId: evaluation.matchedRuleId,
            };
        }

        if (evaluation.decision === 'require_approval') {
            const consumedApproval = await consumeApprovedAction(
                tool,
                args,
                approvalPath,
                evaluation.matchedRuleId,
            );

            if (consumedApproval) {
                return {
                    allowed: true,
                    decision: 'allow',
                    matchedRuleId: evaluation.matchedRuleId,
                };
            }

            const normalized = normalizeToolAction(tool, args);
            const pending = await createPendingApproval(
                {
                    tool,
                    args,
                    ruleId: evaluation.matchedRuleId,
                    resource: normalized?.resource,
                },
                approvalPath,
            );

            const ruleText = evaluation.matchedRuleId
                ? ` Policy rule: ${evaluation.matchedRuleId}.`
                : '';

            return {
                allowed: false,
                decision: 'require_approval',
                matchedRuleId: evaluation.matchedRuleId,
                result: policyResult(
                    `Approval required before ${tool} can run. No action was executed. Approval request ID: ${pending.id}.${ruleText}`,
                ),
            };
        }

        const ruleText = evaluation.matchedRuleId
            ? ` Policy rule: ${evaluation.matchedRuleId}.`
            : '';

        return {
            allowed: false,
            decision: 'deny',
            matchedRuleId: evaluation.matchedRuleId,
            result: policyResult(
                `Blocked by Desktop Commander access policy. No action was executed.${ruleText}`,
            ),
        };
    } catch (error) {
        const reason = error instanceof Error ? error.message : String(error);

        return {
            allowed: false,
            decision: 'deny',
            result: policyResult(
                `Desktop Commander policy configuration error. No action was executed. ${reason}`,
            ),
        };
    }
}
