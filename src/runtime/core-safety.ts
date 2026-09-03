import type { ServerResult } from '../types.js';
import { isProjectWorkflowControlPlaneResource } from '../workflow/project-workflow.js';

export interface CoreSafetyGateResult {
    allowed: boolean;
    result?: ServerResult;
}

function stringArg(args: unknown, key: string): string | undefined {
    if (!args || typeof args !== 'object') {
        return undefined;
    }
    const value = (args as Record<string, unknown>)[key];
    return typeof value === 'string' ? value : undefined;
}

function filesystemMutationResources(tool: string, args: unknown): string[] {
    switch (tool) {
        case 'write_file':
        case 'create_directory':
        case 'delete_file':
            return [stringArg(args, 'path')].filter(
                (value): value is string => !!value,
            );
        case 'edit_block':
            return [stringArg(args, 'file_path')].filter(
                (value): value is string => !!value,
            );
        case 'write_pdf':
            return [
                stringArg(args, 'outputPath') ?? stringArg(args, 'path'),
            ].filter((value): value is string => !!value);
        case 'move_file':
            return [
                stringArg(args, 'source'),
                stringArg(args, 'destination'),
            ].filter((value): value is string => !!value);
        default:
            return [];
    }
}

function blockedResult(): ServerResult {
    return {
        content: [{
            type: 'text',
            text:
                'Blocked by Desktop Commander access policy. No action was executed. ' +
                'Policy rule: system:project-workflow-control-plane.',
        }],
        isError: true,
    };
}

/**
 * Shared safety gate that remains active even in the Free composition.
 *
 * Commercial policy is optional, but an ordinary MCP filesystem mutation must
 * not rewrite the project_workflow control plane used to coordinate trusted
 * lifecycle state.
 */
export async function applyCoreSafetyGate(
    tool: string,
    args: unknown,
): Promise<CoreSafetyGateResult> {
    for (const resource of filesystemMutationResources(tool, args)) {
        if (await isProjectWorkflowControlPlaneResource(resource)) {
            return {
                allowed: false,
                result: blockedResult(),
            };
        }
    }
    return { allowed: true };
}
