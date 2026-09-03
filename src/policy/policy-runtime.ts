import fs from 'node:fs/promises';
import path from 'node:path';
import { USER_HOME } from '../config.js';
import { evaluateToolRequestPolicy } from './tool-policy.js';
import {
    DesktopCommanderTier,
    PolicyAction,
    PolicyEvaluation,
    PolicyRule,
} from './types.js';
import { normalizeToolAction } from './tool-policy.js';

export interface PolicyRuntimeConfig {
    version: 1;
    tier: DesktopCommanderTier;
    deviceId?: string;
    rules: PolicyRule[];
}

export interface PolicyPreflightResult extends PolicyEvaluation {
    tier: DesktopCommanderTier;
    deviceId?: string;
    action?: PolicyAction;
    resource?: string;
}

export const POLICY_FILE = path.join(
    USER_HOME,
    '.claude-server-commander',
    'policy.json',
);

const VALID_TIERS = new Set<DesktopCommanderTier>(['free', 'pro', 'team']);
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

    if (!Array.isArray(config.rules)) {
        throw new Error('rules must be an array');
    }

    if (config.deviceId !== undefined && typeof config.deviceId !== 'string') {
        throw new Error('deviceId must be a string');
    }

    return {
        version: 1,
        tier: config.tier as DesktopCommanderTier,
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
export async function loadPolicyRuntimeConfig(
    policyPath?: string,
): Promise<PolicyRuntimeConfig> {
    const resolvedPolicyPath =
        policyPath ?? process.env.DESKTOP_COMMANDER_POLICY_FILE ?? POLICY_FILE;

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
    const normalized = normalizeToolAction(tool, args);
    const evaluation = evaluateToolRequestPolicy(tool, args, {
        tier: config.tier,
        deviceId: config.deviceId,
        rules: config.rules,
    });

    return {
        ...evaluation,
        tier: config.tier,
        ...(config.deviceId ? { deviceId: config.deviceId } : {}),
        ...(normalized ? { action: normalized.action } : {}),
        ...(normalized?.resource ? { resource: normalized.resource } : {}),
    };
}
