import { DesktopCommanderTier, PolicyProfile, PolicyRule } from './types.js';


const PAID_TIER_BASELINE_RULES: readonly PolicyRule[] = [
    {
        id: 'tier:paid:terminal',
        action: 'terminal.execute',
        decision: 'require_approval',
    },
    {
        id: 'tier:paid:process-terminate',
        action: 'process.terminate',
        decision: 'require_approval',
    },
    {
        id: 'tier:paid:config',
        action: 'config.change',
        decision: 'require_approval',
    },
];

export function getTierBaselineRules(
    tier: DesktopCommanderTier,
): readonly PolicyRule[] {
    return tier === 'free' ? [] : PAID_TIER_BASELINE_RULES;
}

const SAFE_DEVELOPER_RULES: readonly PolicyRule[] = [
    {
        id: 'profile:safe-developer:terminal',
        action: 'terminal.execute',
        decision: 'require_approval',
    },
    {
        id: 'profile:safe-developer:process-terminate',
        action: 'process.terminate',
        decision: 'require_approval',
    },
    {
        id: 'profile:safe-developer:config',
        action: 'config.change',
        decision: 'require_approval',
    },
];

const READ_ONLY_RULES: readonly PolicyRule[] = [
    {
        id: 'profile:read-only:filesystem-write',
        action: 'filesystem.write',
        decision: 'deny',
    },
    {
        id: 'profile:read-only:filesystem-move',
        action: 'filesystem.move',
        decision: 'deny',
    },
    {
        id: 'profile:read-only:filesystem-delete',
        action: 'filesystem.delete',
        decision: 'deny',
    },
    {
        id: 'profile:read-only:terminal',
        action: 'terminal.execute',
        decision: 'deny',
    },
    {
        id: 'profile:read-only:process-terminate',
        action: 'process.terminate',
        decision: 'deny',
    },
    {
        id: 'profile:read-only:config',
        action: 'config.change',
        decision: 'deny',
    },
];

export function getPolicyProfileRules(
    profile: PolicyProfile | undefined,
): readonly PolicyRule[] {
    switch (profile) {
        case 'safe_developer':
            return SAFE_DEVELOPER_RULES;
        case 'read_only':
            return READ_ONLY_RULES;
        case 'full_access':
        case undefined:
            return [];
    }
}
