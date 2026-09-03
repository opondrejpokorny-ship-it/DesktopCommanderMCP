import { evaluatePolicy } from './policy-engine.js';
import {
    DesktopCommanderTier,
    PolicyAction,
    PolicyEvaluation,
    PolicyRule,
} from './types.js';

export interface ToolPolicyOptions {
    tier: DesktopCommanderTier;
    rules?: readonly PolicyRule[];
    deviceId?: string;
}

interface NormalizedToolAction {
    action: PolicyAction;
    resource?: string;
}

function getStringArg(args: unknown, key: string): string | undefined {
    if (!args || typeof args !== 'object') {
        return undefined;
    }

    const value = (args as Record<string, unknown>)[key];
    return typeof value === 'string' ? value : undefined;
}

/**
 * Convert Desktop Commander MCP tools into the small action vocabulary used by
 * the prototype policy engine. This module does not execute or validate tools.
 */
export function normalizeToolAction(
    tool: string,
    args: unknown,
): NormalizedToolAction | null {
    switch (tool) {
        case 'read_file':
            return { action: 'filesystem.read', resource: getStringArg(args, 'path') };

        case 'write_file':
        case 'edit_block':
        case 'create_directory':
            return { action: 'filesystem.write', resource: getStringArg(args, 'path') };

        case 'move_file':
            return { action: 'filesystem.move', resource: getStringArg(args, 'source') };

        case 'delete_file':
            return { action: 'filesystem.delete', resource: getStringArg(args, 'path') };

        case 'start_process':
            return { action: 'terminal.execute', resource: getStringArg(args, 'command') };

        case 'force_terminate':
        case 'kill_process':
            return { action: 'process.terminate' };

        case 'set_config_value':
            return { action: 'config.change', resource: getStringArg(args, 'key') };

        default:
            return null;
    }
}

/**
 * Evaluate an actual MCP tool request against prototype tier policies.
 *
 * Unmapped tools remain allowed. Their existing Desktop Commander validation
 * and behavior are unchanged.
 */
export function evaluateToolRequestPolicy(
    tool: string,
    args: unknown,
    options: ToolPolicyOptions,
): PolicyEvaluation {
    const normalized = normalizeToolAction(tool, args);

    if (!normalized) {
        return { decision: 'allow' };
    }

    return evaluatePolicy(
        {
            tier: options.tier,
            tool,
            action: normalized.action,
            resource: normalized.resource,
            deviceId: options.deviceId,
        },
        options.rules ?? [],
    );
}
