import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { USER_HOME } from '../config.js';
import { normalizeCommandPrefix as normalizeShellCommandPrefix } from './command-policy.js';
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

export type FolderPermission =
    | 'inherit'
    | 'read_write'
    | 'read_only'
    | 'approval_required'
    | 'blocked';

export interface FolderPermissionEntry {
    path: string;
    permission: Exclude<FolderPermission, 'inherit'>;
    deviceId?: string;
}

export type CommandPermission =
    | 'inherit'
    | 'allow'
    | 'approval_required'
    | 'blocked';

export interface CommandPermissionEntry {
    commandPrefix: string;
    permission: Exclude<CommandPermission, 'inherit'>;
    deviceId?: string;
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

export const VALID_FOLDER_PERMISSIONS = new Set<FolderPermission>([
    'inherit',
    'read_write',
    'read_only',
    'approval_required',
    'blocked',
]);

export const VALID_COMMAND_PERMISSIONS = new Set<CommandPermission>([
    'inherit',
    'allow',
    'approval_required',
    'blocked',
]);

const MANAGED_COMMAND_RULE_PREFIX = 'control-center-command:';

const MANAGED_FOLDER_RULE_PREFIX = 'control-center-folder:';
const MANAGED_FOLDER_ACTIONS: PolicyAction[] = [
    'filesystem.read',
    'filesystem.write',
    'filesystem.move',
    'filesystem.delete',
];
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

    if (rule.commandPrefix !== undefined && typeof rule.commandPrefix !== 'string') {
        throw new Error(`rules[${index}].commandPrefix must be a string`);
    }

    if (rule.deviceId !== undefined && typeof rule.deviceId !== 'string') {
        throw new Error(`rules[${index}].deviceId must be a string`);
    }

    return {
        id: rule.id,
        action: rule.action as PolicyAction,
        decision: rule.decision as PolicyRule['decision'],
        ...(rule.resourcePrefix !== undefined ? { resourcePrefix: rule.resourcePrefix } : {}),
        ...(rule.commandPrefix !== undefined
            ? { commandPrefix: normalizeManagedCommandPrefix(rule.commandPrefix) }
            : {}),
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

export function isFolderPermission(value: string): value is FolderPermission {
    return VALID_FOLDER_PERMISSIONS.has(value as FolderPermission);
}

export function isCommandPermission(value: string): value is CommandPermission {
    return VALID_COMMAND_PERMISSIONS.has(value as CommandPermission);
}

function normalizeOptionalPolicyDeviceId(
    deviceId?: string,
): string | undefined {
    if (deviceId === undefined) {
        return undefined;
    }

    const normalized = deviceId.trim();
    if (!normalized || normalized.length > 256 || /[\u0000-\u001f]/.test(normalized)) {
        throw new Error('Invalid device ID');
    }
    return normalized;
}

function normalizeManagedCommandPrefix(value: string): string {
    const input = value.trim();
    if (!input) {
        throw new Error('Command prefix must not be empty');
    }
    if (input.includes('\0')) {
        throw new Error('Command prefix must not contain NUL bytes');
    }
    if (input.length > 512) {
        throw new Error('Command prefix is too long');
    }
    return normalizeShellCommandPrefix(input);
}

function managedCommandRuleId(
    commandPrefix: string,
    deviceId?: string,
): string {
    const key = deviceId ? `${deviceId}\0${commandPrefix}` : commandPrefix;
    const digest = crypto
        .createHash('sha256')
        .update(key)
        .digest('hex')
        .slice(0, 16);
    return `${MANAGED_COMMAND_RULE_PREFIX}${digest}`;
}

function commandDecision(
    permission: Exclude<CommandPermission, 'inherit'>,
): PolicyRule['decision'] {
    if (permission === 'blocked') {
        return 'deny';
    }
    if (permission === 'approval_required') {
        return 'require_approval';
    }
    return 'allow';
}

export function listCommandPermissions(
    config: PolicyRuntimeConfig,
): CommandPermissionEntry[] {
    return config.rules
        .filter(
            (rule) =>
                rule.id.startsWith(MANAGED_COMMAND_RULE_PREFIX) &&
                rule.action === 'terminal.execute' &&
                !!rule.commandPrefix,
        )
        .map((rule) => ({
            commandPrefix: rule.commandPrefix!,
            ...(rule.deviceId ? { deviceId: rule.deviceId } : {}),
            permission:
                rule.decision === 'deny'
                    ? 'blocked'
                    : rule.decision === 'require_approval'
                        ? 'approval_required'
                        : 'allow',
        }));
}

export async function setCommandPermission(
    commandPrefix: string,
    permission: CommandPermission,
    policyPath?: string,
    deviceId?: string,
): Promise<PolicyRuntimeConfig> {
    const normalized = normalizeManagedCommandPrefix(commandPrefix);
    const normalizedDeviceId = normalizeOptionalPolicyDeviceId(deviceId);
    const ruleId = managedCommandRuleId(normalized, normalizedDeviceId);

    return updatePolicyRuntimeConfig((current) => {
        const rules = current.rules.filter((rule) => rule.id !== ruleId);

        if (permission !== 'inherit') {
            rules.unshift({
                id: ruleId,
                action: 'terminal.execute',
                commandPrefix: normalized,
                ...(normalizedDeviceId ? { deviceId: normalizedDeviceId } : {}),
                decision: commandDecision(permission),
            });
        }

        return { ...current, rules };
    }, policyPath);
}

export function isAbsolutePolicyPath(value: string): boolean {
    return path.posix.isAbsolute(value) || path.win32.isAbsolute(value);
}

function managedFolderRulePrefix(
    resourcePrefix: string,
    deviceId?: string,
): string {
    const key = deviceId ? `${deviceId}\0${resourcePrefix}` : resourcePrefix;
    const digest = crypto
        .createHash('sha256')
        .update(key)
        .digest('hex')
        .slice(0, 16);
    return `${MANAGED_FOLDER_RULE_PREFIX}${digest}:`;
}

function decisionForFolderAction(
    permission: Exclude<FolderPermission, 'inherit'>,
    action: PolicyAction,
): PolicyRule['decision'] {
    if (permission === 'blocked') {
        return 'deny';
    }
    if (action === 'filesystem.read') {
        return 'allow';
    }
    if (permission === 'read_write') {
        return 'allow';
    }
    if (permission === 'read_only') {
        return 'deny';
    }
    return 'require_approval';
}

function buildManagedFolderRules(
    resourcePrefix: string,
    permission: Exclude<FolderPermission, 'inherit'>,
    deviceId?: string,
): PolicyRule[] {
    const idPrefix = managedFolderRulePrefix(resourcePrefix, deviceId);
    return MANAGED_FOLDER_ACTIONS.map((action) => ({
        id: `${idPrefix}${action.replace('filesystem.', '')}`,
        action,
        resourcePrefix,
        ...(deviceId ? { deviceId } : {}),
        decision: decisionForFolderAction(permission, action),
    }));
}

export function listFolderPermissions(
    config: PolicyRuntimeConfig,
): FolderPermissionEntry[] {
    const grouped = new Map<string, {
        resourcePrefix: string;
        deviceId?: string;
        rules: PolicyRule[];
    }>();

    for (const rule of config.rules) {
        if (
            !rule.id.startsWith(MANAGED_FOLDER_RULE_PREFIX) ||
            !rule.resourcePrefix
        ) {
            continue;
        }

        const key = JSON.stringify([rule.resourcePrefix, rule.deviceId ?? null]);
        const group = grouped.get(key) ?? {
            resourcePrefix: rule.resourcePrefix,
            ...(rule.deviceId ? { deviceId: rule.deviceId } : {}),
            rules: [],
        };
        group.rules.push(rule);
        grouped.set(key, group);
    }

    return [...grouped.values()].map(({ resourcePrefix, deviceId, rules }) => {
        const read = rules.find((rule) => rule.action === 'filesystem.read');
        const write = rules.find((rule) => rule.action === 'filesystem.write');

        let permission: FolderPermissionEntry['permission'];
        if (read?.decision === 'deny') {
            permission = 'blocked';
        } else if (write?.decision === 'allow') {
            permission = 'read_write';
        } else if (write?.decision === 'require_approval') {
            permission = 'approval_required';
        } else {
            permission = 'read_only';
        }

        return {
            path: resourcePrefix,
            permission,
            ...(deviceId ? { deviceId } : {}),
        };
    });
}

export async function setFolderPermission(
    resourcePrefix: string,
    permission: FolderPermission,
    policyPath?: string,
    deviceId?: string,
): Promise<PolicyRuntimeConfig> {
    const normalizedInput = resourcePrefix.trim();
    if (!isAbsolutePolicyPath(normalizedInput)) {
        throw new Error('Folder permission path must be absolute');
    }

    const normalizedDeviceId = normalizeOptionalPolicyDeviceId(deviceId);
    const idPrefix = managedFolderRulePrefix(normalizedInput, normalizedDeviceId);
    return updatePolicyRuntimeConfig((current) => {
        const rules = current.rules.filter(
            (rule) => !rule.id.startsWith(idPrefix),
        );

        if (permission !== 'inherit') {
            rules.unshift(...buildManagedFolderRules(
                normalizedInput,
                permission,
                normalizedDeviceId,
            ));
        }

        return { ...current, rules };
    }, policyPath);
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

export async function setPolicyDeviceId(
    deviceId: string,
    policyPath?: string,
): Promise<PolicyRuntimeConfig> {
    const normalized = normalizeOptionalPolicyDeviceId(deviceId)!;

    return updatePolicyRuntimeConfig(
        (current) => ({ ...current, deviceId: normalized }),
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
