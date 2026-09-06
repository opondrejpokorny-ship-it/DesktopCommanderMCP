import type { ServerResult } from '../types.js';
import {
    getProjectWorkflowProgressRequirement,
    getProjectWorkflowProgressRequirementForResolvedRoot,
    type WorkflowProgressReportingView,
} from './project-workflow.js';

export interface ProgressEnforcementGateResult {
    allowed: boolean;
    result?: ServerResult;
}

export interface ProgressEnforcementGateOptions {
    projectRoots?: string[];
}

const DIRECT_REPOSITORY_MUTATION_TOOLS = new Set([
    'write_file',
    'edit_block',
    'create_directory',
    'move_file',
    'write_pdf',
    'delete_file',
]);

function stringArg(args: unknown, key: string): string | undefined {
    if (!args || typeof args !== 'object') return undefined;
    const value = (args as Record<string, unknown>)[key];
    return typeof value === 'string' && value.trim() ? value : undefined;
}

function blockedResult(
    projectRoot: string,
    requirement: WorkflowProgressReportingView,
): ServerResult {
    return {
        content: [{
            type: 'text',
            text:
                'PROGRESS_REPORT_REQUIRED: Whole-task progress reporting is due. ' +
                'No action was executed. Call report_task_progress with projectRoot before retrying.',
        }],
        structuredContent: {
            code: 'PROGRESS_REPORT_REQUIRED',
            projectRoot,
            requiredTool: 'report_task_progress',
            reason: requirement.reason ?? 'interval',
            lastReportedAt: requirement.lastReportedAt,
            dueAt: requirement.dueAt,
            ...(requirement.pendingMilestone
                ? { milestoneStageId: requirement.pendingMilestone.stageId }
                : {}),
        },
        isError: true,
    };
}

function checkFailedResult(projectRoot: string): ServerResult {
    return {
        content: [{
            type: 'text',
            text:
                'PROGRESS_REPORT_CHECK_FAILED: Active workflow progress state could not be verified. ' +
                'No action was executed. Inspect project_workflow status before retrying.',
        }],
        structuredContent: {
            code: 'PROGRESS_REPORT_CHECK_FAILED',
            projectRoot,
            requiredTool: 'project_workflow',
        },
        isError: true,
    };
}

export async function applyProgressEnforcementGate(
    tool: string,
    args: unknown,
    options: ProgressEnforcementGateOptions = {},
): Promise<ProgressEnforcementGateResult> {
    if (tool === 'report_task_progress') {
        return { allowed: true };
    }

    if (tool === 'project_workflow') {
        const action = stringArg(args, 'action');
        if (action !== 'record' && action !== 'finish') {
            return { allowed: true };
        }
        const projectRoot = stringArg(args, 'projectRoot');
        if (!projectRoot) {
            return { allowed: true };
        }
        try {
            const requirement = await getProjectWorkflowProgressRequirement(
                { projectRoot },
                { forcePendingMilestone: action === 'finish' },
            );
            return requirement?.required
                ? { allowed: false, result: blockedResult(projectRoot, requirement) }
                : { allowed: true };
        } catch {
            return { allowed: false, result: checkFailedResult(projectRoot) };
        }
    }

    if (!DIRECT_REPOSITORY_MUTATION_TOOLS.has(tool)) {
        return { allowed: true };
    }

    for (const projectRoot of new Set(options.projectRoots ?? [])) {
        try {
            const requirement =
                await getProjectWorkflowProgressRequirementForResolvedRoot(projectRoot);
            if (requirement?.required) {
                return { allowed: false, result: blockedResult(projectRoot, requirement) };
            }
        } catch {
            return { allowed: false, result: checkFailedResult(projectRoot) };
        }
    }

    return { allowed: true };
}