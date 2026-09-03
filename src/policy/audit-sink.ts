import type { PolicyAction, PolicyDecision } from './types.js';

export type AuditEventType =
    | 'policy_decision'
    | 'approval_decision'
    | 'execution_result';

export interface AuditEventInput {
    type: AuditEventType;
    requestId: string;
    tool: string;
    action?: PolicyAction;
    resource?: string;
    deviceId?: string;
    decision?: PolicyDecision;
    ruleId?: string;
    approvalRequestId?: string;
    approvalDecision?: 'approved' | 'denied';
    outcome?: 'success' | 'failure';
    durationMs?: number;
}

export interface AuditSink {
    append(input: AuditEventInput): Promise<unknown>;
}
