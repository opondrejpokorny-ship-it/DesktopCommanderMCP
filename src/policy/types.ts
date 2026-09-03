export type DesktopCommanderTier = 'free' | 'pro' | 'team';

export type PolicyProfile =
    | 'full_access'
    | 'safe_developer'
    | 'read_only';

export type PolicyDecision = 'allow' | 'deny' | 'require_approval';

export type PolicyAction =
    | 'filesystem.read'
    | 'filesystem.write'
    | 'filesystem.move'
    | 'filesystem.delete'
    | 'terminal.execute'
    | 'process.terminate'
    | 'config.change';

export interface PolicyContext {
    tier: DesktopCommanderTier;
    tool: string;
    action: PolicyAction;
    resource?: string;
    deviceId?: string;
}

export interface PolicyRule {
    id: string;
    action: PolicyAction;
    resourcePrefix?: string;
    deviceId?: string;
    decision: PolicyDecision;
}

export interface PolicyEvaluation {
    decision: PolicyDecision;
    matchedRuleId?: string;
}
