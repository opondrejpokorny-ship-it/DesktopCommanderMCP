import { ServerResult } from '../types.js';
import { ProjectWorkflowArgsSchema } from './schemas.js';
import {
    finishProjectWorkflow,
    getProjectWorkflowStatus,
    recordOperationalLesson,
    recordProjectWorkflowStage,
    resumeProjectWorkflow,
    startProjectWorkflow,
    WorkflowStatus,
} from '../workflow/project-workflow.js';

function renderWorkflowSummary(status: WorkflowStatus): string {
    const lines = [
        'Project workflow: ' + status.profile.name,
        'Goal: ' + status.goal,
        'Progress: ' + status.progress.percentComplete + '% complete (' +
            status.progress.percentRemaining + '% remaining)',
        'Git: ' + status.git.branch + ' @ ' + status.git.head.slice(0, 12) +
            (status.git.dirty ? ' (dirty)' : ' (clean)'),
    ];

    if (status.profileDrifted) {
        lines.push('Warning: workflow profile changed after this task started.');
    }

    const staleStages = status.stages.filter((stage) => stage.evidenceStale);
    if (staleStages.length) {
        lines.push(
            'Warning: Git-HEAD scoped evidence is stale: ' +
                staleStages.map((stage) => stage.id).join(', '),
        );
    }

    if (status.operationalMemory.lessons.length > 0) {
        lines.push('Relevant operational lessons from prior attempts:');
        for (const item of status.operationalMemory.lessons) {
            lines.push(
                '- ' + item.lesson +
                (item.occurrences > 1 ? ' (seen ' + item.occurrences + ' times)' : ''),
            );
        }
    }

    if (status.waitingStages.length) {
        lines.push(
            'Waiting on external dependency: ' +
                status.waitingStages
                    .map((stage) => stage.id + ' — ' + stage.label)
                    .join(', '),
        );
        if (
            status.recommendedStage &&
            status.nextStage &&
            status.recommendedStage.id !== status.nextStage.id
        ) {
            lines.push(
                'Recommended safe work while waiting: ' +
                    status.recommendedStage.id + ' — ' + status.recommendedStage.label,
            );
        } else {
            lines.push('Re-check the external dependency before advancing.');
        }
    }

    if (status.nextStage) {
        lines.push(
            'Next lifecycle stage: ' + status.nextStage.id + ' — ' + status.nextStage.label,
        );
    } else if (status.completed) {
        lines.push('Workflow complete. Required lifecycle evidence is recorded.');
    } else {
        lines.push('No pending stage is selected; finish the workflow to validate completion.');
    }

    return lines.join('\n');
}

export async function projectWorkflow(args: unknown): Promise<ServerResult> {
    try {
        const parsed = ProjectWorkflowArgsSchema.parse(args);
        let status: WorkflowStatus;

        switch (parsed.action) {
            case 'start':
                status = await startProjectWorkflow({
                    projectRoot: parsed.projectRoot,
                    goal: parsed.goal,
                    restart: parsed.restart,
                });
                break;
            case 'status':
                status = await getProjectWorkflowStatus({
                    projectRoot: parsed.projectRoot,
                });
                break;
            case 'resume':
                status = await resumeProjectWorkflow({
                    projectRoot: parsed.projectRoot,
                });
                break;
            case 'record':
                status = await recordProjectWorkflowStage({
                    projectRoot: parsed.projectRoot,
                    stageId: parsed.stageId,
                    status: parsed.status,
                    evidence: parsed.evidence,
                    reason: parsed.reason,
                });
                break;
            case 'learn':
                if (!await recordOperationalLesson({
                    projectRoot: parsed.projectRoot,
                    lessonCode: parsed.lessonCode,
                })) {
                    throw new Error('No active workflow matched the requested project root.');
                }
                status = await getProjectWorkflowStatus({
                    projectRoot: parsed.projectRoot,
                });
                break;
            case 'finish':
                status = await finishProjectWorkflow({
                    projectRoot: parsed.projectRoot,
                });
                break;
        }

        return {
            content: [{ type: 'text', text: renderWorkflowSummary(status) }],
            structuredContent: status as unknown as Record<string, unknown>,
        };
    } catch (error) {
        return {
            content: [{
                type: 'text',
                text: 'Project workflow error: ' +
                    (error instanceof Error ? error.message : String(error)),
            }],
            isError: true,
        };
    }
}
