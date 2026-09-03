import { ServerResult } from '../types.js';
import {
    checkActiveWork,
    listActiveWork,
    registerActiveWork,
    removeActiveWork,
    updateActiveWork,
} from '../workflow/active-work-registry.js';
import { ActiveWorkRegistryArgsSchema } from './active-work-registry-schema.js';

function renderGuidance(guidance: string): string {
    switch (guidance) {
        case 'continue_existing':
            return 'Continue existing work only when sharing it is clearly intended and safe; avoid duplicate implementation.';
        case 'wait_or_read_only':
            return 'Overlapping active work exists. Do not make concurrent mutations in the overlapping area; prefer read-only or unrelated safe work.';
        default:
            return 'No conflicting active work was found. Register this task before material edits.';
    }
}

export async function activeWorkRegistry(args: unknown): Promise<ServerResult> {
    try {
        const parsed = ActiveWorkRegistryArgsSchema.parse(args);
        let result: Record<string, unknown>;
        let summary: string;

        switch (parsed.action) {
            case 'check': {
                const checked = await checkActiveWork(parsed);
                result = checked as unknown as Record<string, unknown>;
                summary =
                    'Active work registry: ' + checked.guidance + '.\n' +
                    renderGuidance(checked.guidance);
                break;
            }
            case 'register': {
                const registered = await registerActiveWork(parsed);
                result = registered as unknown as Record<string, unknown>;
                summary = registered.registered
                    ? 'Active work registered: ' + registered.entry?.title
                    : 'Active work not registered: ' + registered.guidance + '.\n' +
                        renderGuidance(registered.guidance);
                break;
            }
            case 'list': {
                const listed = await listActiveWork(parsed);
                result = listed as unknown as Record<string, unknown>;
                summary =
                    'Active work registry contains ' + listed.entries.length +
                    ' unfinished item(s) for ' + listed.repository.display + '.';
                break;
            }
            case 'update': {
                const updated = await updateActiveWork(parsed);
                result = updated as unknown as Record<string, unknown>;
                summary = 'Active work updated: ' + updated.entry.title;
                break;
            }
            case 'remove': {
                const removed = await removeActiveWork(parsed);
                result = removed as unknown as Record<string, unknown>;
                summary = removed.removed
                    ? 'Active work entry removed after caller-requested closure.'
                    : 'Active work entry was not found for this repository.';
                break;
            }
        }

        return {
            content: [{ type: 'text', text: summary }],
            structuredContent: result,
        };
    } catch (error) {
        return {
            content: [{
                type: 'text',
                text:
                    'Active work registry error: ' +
                    (error instanceof Error ? error.message : String(error)),
            }],
            isError: true,
        };
    }
}
