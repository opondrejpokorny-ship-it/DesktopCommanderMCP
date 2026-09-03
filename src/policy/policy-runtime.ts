import fs from 'node:fs/promises';
import path from 'node:path';
import { USER_HOME } from '../config.js';
import { getPolicyProfileRules } from './policy-profiles.js';
import { evaluateToolRequestPolicy } from './tool-policy.js';
import {
    DesktopCommanderTier,
    PolicyAction,
    PolicyEvaluation,
    PolicyProfile,
    PolicyRule,
} from './types.js';

export interface PolicyRuntimeConfig {
    version: 1;
    tier: DesktopCommanderTier;
    profile?: PolicyProfile;
    deviceId?: string;
    rules: PolicyRule[];
}

export interface PolicyPreflightResult extends PolicyEvaluation {
    tier: DesktopCommanderTier;
    profile?: PolicyProfile;
    deviceId?: string;
    action?: PolicyAction;
    resource?: string;
}

export const POLICY_FILE = path.join(
    USER_HOME,
    '.claude-server-commander',
    'policy.json',
);

export const VALID_TIERS = new Set<DesktopCommanderTier>(['free', 'pro', 'team']);
export const VALID_PROFILES = new Set<PolicyProfile>([
    'full_access',
    'safe_developer',
    'read_only',
]);
const VALID_DECISIONS = new Set(['allow', 'deny', 'require_approval']);
const VALID_ACTIONS = new Set<PolicyAction>([
    'filesystem.read',
    'filesystem.write',
    'filesystem.move',
    'filesystem.delete',
    'terminal.execute',
    'process.terminate',
    'config.change',
]);

function defaultPolicyConfig(): PolicyRuntimeConfig {
    return {
        version: 1,
        tier: 'free',
        rules: [],
    };
}

function parsePolicyRule(value: unknown, index: number): PolicyRule {
    if (!value || typeof value !== 'object') {
        throw new Error(`rules[${index}] must be an object`);
    }

    const rule = value as Record<string, unknown>;

    if (typeof rule.id !== 'string' || rule.id.trim().length === 0) {
        throw new Error(`rules[${index}].id must be a non-empty string`);
    }

    if (typeof rule.action !== 'string' || !VALID_ACTIONS.has(rule.action as PolicyAction)) {
        throw new Error(`rules[${index}].action is invalid`);
    }

    if (typeof rule.decision !== 'string' || !VALID_DECISIONS.has(rule.decision)) {
        throw new Error(`rules[${index}].decision is invalid`);
    }

    if (rule.resourcePrefix !== undefined && typeof rule.resourcePrefix !== 'string') {
        throw new Error(`rules[${index}].resourcePrefix must be a string`);
    }

    if (rule.deviceId !== undefined && typeof rule.deviceId !== 'string') {
        throw new Error(`rules[${index}].deviceId must be a string`);
    }

    return {
        id: rule.id,
        action: rule.action as PolicyAction,
        decision: rule.decision as PolicyRule['decision'],
        ...(rule.resourcePrefix !== undefined ? { resourcePrefix: rule.resourcePrefix } : {}),
        ...(rule.deviceId !== undefined ? { deviceId: rule.deviceId } : {}),
    };
}

function parsePolicyConfig(value: unknown): PolicyRuntimeConfig {
    if (!value || typeof value !== 'object') {
        throw new Error('policy root must be an object');
    }

    const config = value as Record<string, unknown>;

    if (config.version !== 1) {
        throw new Error('version must be 1');
    }

    if (typeof config.tier !== 'string' || !VALID_TIERS.has(config.tier as DesktopCommanderTier)) {
        throw new Error('tier must be free, pro, or team');
    }

    if (
        config.profile !== undefined &&
        (typeof config.profile !== 'string' ||
            !VALID_PROFILES.has(config.profile as PolicyProfile))
    ) {
        throw new Error('profile must be full_access, safe_developer, or read_only');
    }

    if (!Array.isArray(config.rules)) {
        throw new Error('rules must be an array');
    }

    if (config.deviceId !== undefined && typeof config.deviceId !== 'string') {
        throw new Error('deviceId must be a string');
    }

    return {
        version: 1,
        tier: config.tier as DesktopCommanderTier,
        ...(config.profile !== undefined
            ? { profile: config.profile as PolicyProfile }
            : {}),
        ...(config.deviceId !== undefined ? { deviceId: config.deviceId } : {}),
        rules: config.rules.map(parsePolicyRule),
    };
}

/**
 * Load the prototype access policy.
 *
 * Missing file = Free, preserving upstream Desktop Commander behavior.
 * Existing but invalid file = error, so a broken policy cannot silently disable
 * restrictions.
 */
function resolvePolicyPath(policyPath?: string): string {
    return policyPath ?? process.env.DESKTOP_COMMANDER_POLICY_FILE ?? POLICY_FILE;
}

export function isDesktopCommanderTier(value: string): value is DesktopCommanderTier {
    return VALID_TIERS.has(value as DesktopCommanderTier);
}

export function isPolicyProfile(value: string): value is PolicyProfile {
    return VALID_PROFILES.has(value as PolicyProfile);
}

async function persistPolicyRuntimeConfig(
    config: PolicyRuntimeConfig,
    policyPath?: string,
): Promise<PolicyRuntimeConfig> {
    const parsed = parsePolicyConfig(config);
    const resolvedPolicyPath = resolvePolicyPath(policyPath);
    await fs.mkdir(path.dirname(resolvedPolicyPath), { recursive: true });

    const tempPath = `${resolvedPolicyPath}.tmp-${process.pid}-${Date.now()}`;
    try {
        await fs.writeFile(tempPath, JSON.stringify(parsed, null, 2), 'utf8');
        try {
            await fs.rename(tempPath, resolvedPolicyPath);
        } catch (error) {
            if ((error as NodeJS.ErrnoException).code !== 'EPERM') {
                throw error;
            }
            await fs.rm(resolvedPolicyPath, { force: true });
            await fs.rename(tempPath, resolvedPolicyPath);
        }
    } finally {
        await fs.rm(tempPath, { force: true }).catch(() => undefined);
    }

    return parsed;
}

let policyWriteChain: Promise<void> = Promise.resolve();

async function updatePolicyRuntimeConfig(
    update: (current: PolicyRuntimeConfig) => PolicyRuntimeConfig,
    policyPath?: string,
): Promise<PolicyRuntimeConfig> {
    let updated: PolicyRuntimeConfig | undefined;

    const operation = policyWriteChain.then(async () => {
        const current = await loadPolicyRuntimeConfig(policyPath);
        updated = await persistPolicyRuntimeConfig(update(current), policyPath);
    });

    policyWriteChain = operation.catch(() => undefined);
    await operation;

    if (!updated) {
        throw new Error('Policy update did not produce a result');
    }
    return updated;
}

export async function setPolicyTier(
    tier: DesktopCommanderTier,
    policyPath?: string,
): Promise<PolicyRuntimeConfig> {
    return updatePolicyRuntimeConfig(
        (current) => ({ ...current, tier }),
        policyPath,
    );
}

export async function setPolicyProfile(
    profile: PolicyProfile,
    policyPath?: string,
): Promise<PolicyRuntimeConfig> {
    return updatePolicyRuntimeConfig(
        (current) => ({ ...current, profile }),
        policyPath,
    );
}

export async function loadPolicyRuntimeConfig(
    policyPath?: string,
): Promise<PolicyRuntimeConfig> {
    const resolvedPolicyPath = resolvePolicyPath(policyPath);

    let raw: string;

    try {
        raw = await fs.readFile(resolvedPolicyPath, 'utf8');
    } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
            return defaultPolicyConfig();
        }
        throw error;
    }

    try {
        return parsePolicyConfig(JSON.parse(raw));
    } catch (error) {
        const reason = error instanceof Error ? error.message : String(error);
        throw new Error(`Invalid Desktop Commander policy file: ${reason}`);
    }
}

export async function preflightToolRequest(
    tool: string,
    args: unknown,
    policyPath?: string,
): Promise<PolicyPreflightResult> {
    const config = await loadPolicyRuntimeConfig(policyPath);

    // Explicit rules are evaluated before profile defaults so advanced users can
    // make deliberate exceptions while still starting from a safe preset.
    const effectiveRules = [
        ...config.rules,
        ...getPolicyProfileRules(config.profile),
    ];

    const evaluation = evaluateToolRequestPolicy(tool, args, {
        tier: config.tier,
        deviceId: config.deviceId,
        rules: effectiveRules,
    });

    return {
        ...evaluation,
        tier: config.tier,
        ...(config.profile ? { profile: config.profile } : {}),
        ...(config.deviceId ? { deviceId: config.deviceId } : {}),
        ...(evaluation.action ? { action: evaluation.action } : {}),
        ...(evaluation.resource ? { resource: evaluation.resource } : {}),
    };
}
