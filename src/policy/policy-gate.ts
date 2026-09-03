import { randomUUID } from 'node:crypto';
import { ServerResult } from '../types.js';
import { createPendingApproval, consumeApprovedAction } from './approval-store.js';
import type { AuditSink } from './audit-sink.js';
import { PolicyPreflightResult, preflightToolRequest } from './policy-runtime.js';
import {
    DesktopCommanderTier,
    PolicyAction,
    PolicyDecision,
} from './types.js';

export interface PolicyGateOptions {
    allowDeviceScope?: boolean;
    auditEnabled?: boolean;
    auditSink?: AuditSink;
}

export interface PolicyGateResult {
    allowed: boolean;
    decision: PolicyDecision;
    matchedRuleId?: string;
    result?: ServerResult;
    auditRequestId?: string;
    auditEnabled?: boolean;
    auditSink?: AuditSink;
    tier?: DesktopCommanderTier;
    action?: PolicyAction;
    resource?: string;
    deviceId?: string;
}

function policyResult(text: string): ServerResult {
    return {
        content: [{ type: 'text', text }],
        isError: true,
    };
}

function gateMetadata(
    evaluation: PolicyPreflightResult,
    auditRequestId: string | undefined,
    auditEnabled: boolean,
    auditSink: AuditSink | undefined,
): Pick<
    PolicyGateResult,
    'auditRequestId' | 'auditEnabled' | 'auditSink' | 'tier' | 'action' | 'resource' | 'deviceId'
> {
    return {
        ...(auditRequestId ? { auditRequestId } : {}),
        auditEnabled,
        ...(auditSink ? { auditSink } : {}),
        tier: evaluation.tier,
        ...(evaluation.action ? { action: evaluation.action } : {}),
        ...(evaluation.resource ? { resource: evaluation.resource } : {}),
        ...(evaluation.deviceId ? { deviceId: evaluation.deviceId } : {}),
    };
}

async function appendTeamPolicyAudit(
    evaluation: PolicyPreflightResult,
    requestId: string | undefined,
    tool: string,
    decision: PolicyDecision,
    auditEnabled: boolean,
    auditSink: AuditSink | undefined,
    approvalRequestId?: string,
): Promise<void> {
    if (
        !auditEnabled ||
        !auditSink ||
        evaluation.tier !== 'team' ||
        !evaluation.action ||
        !requestId
    ) {
        return;
    }

    try {
        await auditSink.append({
                type: 'policy_decision',
                requestId,
                tool,
                action: evaluation.action,
                resource: evaluation.resource,
                deviceId: evaluation.deviceId,
                decision,
                ruleId: evaluation.matchedRuleId,
                approvalRequestId,
            });
    } catch (error) {
        // Audit logging is observability in this prototype, not an OS security
        // boundary. A logging failure must not silently alter a policy decision.
        console.error(
            'Desktop Commander prototype audit write failed:',
            error instanceof Error ? error.message : String(error),
        );
    }
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
    auditPath?: string,
    options: PolicyGateOptions = {},
): Promise<PolicyGateResult> {
    try {
        const auditSink = options.auditSink;
        const auditEnabled = (options.auditEnabled ?? true) && !!auditSink;
        const evaluation = await preflightToolRequest(
            tool,
            args,
            policyPath,
            { allowDeviceScope: options.allowDeviceScope },
        );
        const auditRequestId =
            auditEnabled && evaluation.tier === 'team' && evaluation.action
                ? randomUUID()
                : undefined;

        if (evaluation.decision === 'allow') {
            await appendTeamPolicyAudit(
                evaluation,
                auditRequestId,
                tool,
                'allow',
                auditEnabled,
                auditSink,
            );

            return {
                allowed: true,
                decision: 'allow',
                matchedRuleId: evaluation.matchedRuleId,
                ...gateMetadata(evaluation, auditRequestId, auditEnabled, auditSink),
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
                await appendTeamPolicyAudit(
                    evaluation,
                    auditRequestId,
                    tool,
                    'allow',
                    auditEnabled,
                    auditSink,
                    consumedApproval.id,
                );

                return {
                    allowed: true,
                    decision: 'allow',
                    matchedRuleId: evaluation.matchedRuleId,
                    ...gateMetadata(evaluation, auditRequestId, auditEnabled, auditSink),
                };
            }

            const pending = await createPendingApproval(
                {
                    tool,
                    args,
                    ruleId: evaluation.matchedRuleId,
                    resource: evaluation.resource,
                    action: evaluation.action,
                    deviceId: evaluation.deviceId,
                    auditRequestId,
                },
                approvalPath,
            );

            await appendTeamPolicyAudit(
                evaluation,
                auditRequestId,
                tool,
                'require_approval',
                auditEnabled,
                auditSink,
                pending.id,
            );

            const ruleText = evaluation.matchedRuleId
                ? ` Policy rule: ${evaluation.matchedRuleId}.`
                : '';

            return {
                allowed: false,
                decision: 'require_approval',
                matchedRuleId: evaluation.matchedRuleId,
                ...gateMetadata(evaluation, auditRequestId, auditEnabled, auditSink),
                result: policyResult(
                    `Approval required before ${tool} can run. No action was executed. Approval request ID: ${pending.id}.${ruleText}`,
                ),
            };
        }

        await appendTeamPolicyAudit(
            evaluation,
            auditRequestId,
            tool,
            'deny',
            auditEnabled,
            auditPath,
        );

        const ruleText = evaluation.matchedRuleId
            ? ` Policy rule: ${evaluation.matchedRuleId}.`
            : '';

        return {
            allowed: false,
            decision: 'deny',
            matchedRuleId: evaluation.matchedRuleId,
            ...gateMetadata(evaluation, auditRequestId, auditEnabled, auditSink),
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

export async function recordPolicyExecutionResult(
    gate: PolicyGateResult,
    tool: string,
    outcome: 'success' | 'failure',
    durationMs: number,
): Promise<void> {
    if (
        !gate.auditEnabled ||
        gate.tier !== 'team' ||
        !gate.auditRequestId ||
        !gate.action
    ) {
        return;
    }

    try {
        await gate.auditSink?.append({
                type: 'execution_result',
                requestId: gate.auditRequestId,
                tool,
                action: gate.action,
                resource: gate.resource,
                deviceId: gate.deviceId,
                outcome,
                durationMs,
            });
    } catch (error) {
        console.error(
            'Desktop Commander prototype audit write failed:',
            error instanceof Error ? error.message : String(error),
        );
    }
}
