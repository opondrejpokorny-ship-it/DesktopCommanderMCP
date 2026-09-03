[Reading 286 lines from start (total: 286 lines, 0 remaining)]

import { evaluatePolicy } from './policy-engine.js';
import {
    DesktopCommanderTier,
    PolicyAction,
    PolicyDecision,
    PolicyEvaluation,
    PolicyRule,
} from './types.js';

export interface ToolPolicyOptions {
    tier: DesktopCommanderTier;
    rules?: readonly PolicyRule[];
    deviceId?: string;
}

export interface NormalizedToolAction {
    action: PolicyAction;
    resource?: string;
}

export interface ToolPolicyEvaluation extends PolicyEvaluation {
    action?: PolicyAction;
    resource?: string;
}

function getStringArg(args: unknown, key: string): string | undefined {
    if (!args || typeof args !== 'object') {
        return undefined;
    }

    const value = (args as Record<string, unknown>)[key];
    return typeof value === 'string' ? value : undefined;
}

function getStringArrayArg(args: unknown, key: string): string[] {
    if (!args || typeof args !== 'object') {
        return [];
    }

    const value = (args as Record<string, unknown>)[key];
    return Array.isArray(value)
        ? value.filter((entry): entry is string => typeof entry === 'string')
        : [];
}

function getPdfSourcePaths(args: unknown): string[] {
    if (!args || typeof args !== 'object') {
        return [];
    }

    const content = (args as Record<string, unknown>).content;
    if (!Array.isArray(content)) {
        return [];
    }

    return content
        .map((operation) => {
            if (!operation || typeof operation !== 'object') {
                return undefined;
            }
            const sourcePdfPath = (operation as Record<string, unknown>).sourcePdfPath;
            return typeof sourcePdfPath === 'string' ? sourcePdfPath : undefined;
        })
        .filter((entry): entry is string => !!entry);
}

/**
 * Convert a Desktop Commander MCP request into all policy-relevant actions.
 *
 * Some tools touch more than one resource (move_file, read_multiple_files,
 * write_pdf modification operations). Every relevant resource must be checked
 * before the tool is allowed to execute.
 */
export function normalizeToolActions(
    tool: string,
    args: unknown,
): NormalizedToolAction[] {
    switch (tool) {
        case 'read_file':
            return [{
                action: 'filesystem.read',
                resource: getStringArg(args, 'path'),
            }];

        case 'read_multiple_files':
            return getStringArrayArg(args, 'paths').map((resource) => ({
                action: 'filesystem.read' as const,
                resource,
            }));

        case 'list_directory':
        case 'get_file_info':
        case 'start_search':
            return [{
                action: 'filesystem.read',
                resource: getStringArg(args, 'path'),
            }];

        case 'write_file':
        case 'create_directory':
            return [{
                action: 'filesystem.write',
                resource: getStringArg(args, 'path'),
            }];

        case 'edit_block':
            return [{
                action: 'filesystem.write',
                resource: getStringArg(args, 'file_path'),
            }];

        case 'write_pdf': {
            const inputPath = getStringArg(args, 'path');
            const outputPath = getStringArg(args, 'outputPath') ?? inputPath;
            const content = args && typeof args === 'object'
                ? (args as Record<string, unknown>).content
                : undefined;

            const actions: NormalizedToolAction[] = [];

            // Modification mode reads the original PDF and any inserted source
            // PDFs before writing the target. Creation from markdown only writes.
            if (Array.isArray(content) && inputPath) {
                actions.push({
                    action: 'filesystem.read',
                    resource: inputPath,
                });

                for (const sourcePdfPath of getPdfSourcePaths(args)) {
                    actions.push({
                        action: 'filesystem.read',
                        resource: sourcePdfPath,
                    });
                }
            }

            actions.push({
                action: 'filesystem.write',
                resource: outputPath,
            });
            return actions;
        }

        case 'move_file':
            return [
                {
                    action: 'filesystem.move',
                    resource: getStringArg(args, 'source'),
                },
                {
                    action: 'filesystem.move',
                    resource: getStringArg(args, 'destination'),
                },
            ];

        case 'delete_file':
            return [{
                action: 'filesystem.delete',
                resource: getStringArg(args, 'path'),
            }];

        case 'start_process':
            return [{
                action: 'terminal.execute',
                resource: getStringArg(args, 'command'),
            }];

        case 'interact_with_process':
            return [{
                action: 'terminal.execute',
            }];

        case 'force_terminate':
        case 'kill_process':
        case 'stop_search':
            return [{
                action: 'process.terminate',
            }];

        case 'project_workflow': {
            const workflowAction = getStringArg(args, 'action');
            if (workflowAction === 'status') {
                return [];
            }
            return [{
                action: 'workflow.change',
                resource: getStringArg(args, 'projectRoot'),
            }];
        }

        case 'give_feedback_to_desktop_commander':
            return [{
                action: 'external.open',
                resource: 'desktop-commander-feedback',
            }];

        case 'set_config_value':
            return [{
                action: 'config.change',
                resource: getStringArg(args, 'key'),
            }];

        default:
            return [];
    }
}

/**
 * Backward-compatible helper for callers that only need the first normalized
 * action. Policy evaluation itself always checks every normalized action.
 */
export function normalizeToolAction(
    tool: string,
    args: unknown,
): NormalizedToolAction | null {
    return normalizeToolActions(tool, args)[0] ?? null;
}

const DECISION_PRIORITY: Record<PolicyDecision, number> = {
    allow: 0,
    require_approval: 1,
    deny: 2,
};

/**
 * Evaluate an actual MCP tool request against prototype tier policies.
 *
 * Every policy-relevant resource touched by a multi-resource tool is evaluated.
 * The strongest decision wins: deny > require_approval > allow.
 */
export function evaluateNormalizedToolActionsPolicy(
    tool: string,
    normalizedActions: readonly NormalizedToolAction[],
    options: ToolPolicyOptions,
): ToolPolicyEvaluation {
    if (normalizedActions.length === 0) {
        return { decision: 'allow' };
    }

    let selected: ToolPolicyEvaluation | undefined;

    for (const normalized of normalizedActions) {
        const evaluation = evaluatePolicy(
            {
                tier: options.tier,
                tool,
                action: normalized.action,
                resource: normalized.resource,
                deviceId: options.deviceId,
            },
            options.rules ?? [],
        );

        const candidate: ToolPolicyEvaluation = {
            ...evaluation,
            action: normalized.action,
            ...(normalized.resource ? { resource: normalized.resource } : {}),
        };

        if (
            !selected ||
            DECISION_PRIORITY[candidate.decision] >
                DECISION_PRIORITY[selected.decision]
        ) {
            selected = candidate;
        }

        if (selected.decision === 'deny') {
            break;
        }
    }

    return selected ?? { decision: 'allow' };
}

export function evaluateToolRequestPolicy(
    tool: string,
    args: unknown,
    options: ToolPolicyOptions,
): ToolPolicyEvaluation {
    return evaluateNormalizedToolActionsPolicy(
        tool,
        normalizeToolActions(tool, args),
        options,
    );
}

[executed on device: WIN-A0OFGC4ORFI (998ddf48-83cd-4223-bfeb-7ac96a8f7a93)]