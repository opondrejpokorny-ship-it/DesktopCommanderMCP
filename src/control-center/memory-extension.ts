import {
    getOperationalMemoryFilterOptions,
    getOperationalMemoryOverview,
    queryOperationalMemoryEvents,
    queryOperationalMemoryGroups,
    type MemoryBrowseScope,
    type MemoryEventQuery,
    type MemoryGroupQuery,
    type MemoryItemKind,
} from '../workflow/operational-memory-query.js';
import type {
    ControlCenterExtensionV1,
    ControlCenterJsonResponseV1,
    ControlCenterRequestContextV1,
} from './contract.js';

const API_PREFIX = '/api/memory' as const;
const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 200;
const SAFE_STRUCTURAL_VALUE = /^[A-Za-z0-9_.:@+\/-]{1,160}$/;
const SAFE_CURSOR = /^[A-Za-z0-9_-]{4,1536}$/;

class MemoryRequestError extends Error {}

function badRequest(message = 'Invalid memory query.'): never {
    throw new MemoryRequestError(message);
}

function valuesFor(
    context: ControlCenterRequestContextV1,
    allowed: readonly string[],
): Record<string, string | undefined> {    const allowedSet = new Set(allowed);
    const result: Record<string, string | undefined> = Object.create(null);
    for (const [key, entries] of Object.entries(context.query)) {
        if (!allowedSet.has(key) || entries.length !== 1) badRequest();
        result[key] = entries[0];
    }
    return result;
}

function structural(value: string | undefined, label: string): string | undefined {
    if (value === undefined) return undefined;
    if (!SAFE_STRUCTURAL_VALUE.test(value)) badRequest(`Invalid memory ${label}.`);
    return value;
}

function scope(value: string | undefined): MemoryBrowseScope {
    const resolved = value ?? 'project';
    if (resolved !== 'workflow' && resolved !== 'project' && resolved !== 'global') {
        badRequest('Invalid memory scope.');
    }
    return resolved;
}

function kind(value: string | undefined): MemoryItemKind | undefined {
    if (value === undefined) return undefined;
    if (value !== 'error' && value !== 'limit' && value !== 'lesson') {
        badRequest('Invalid memory kind.');
    }
    return value;
}
function positiveInteger(
    value: string | undefined,
    label: string,
    maximum = Number.MAX_SAFE_INTEGER,
): number | undefined {
    if (value === undefined) return undefined;
    if (!/^[1-9][0-9]*$/.test(value)) badRequest(`Invalid memory ${label}.`);
    const parsed = Number(value);
    if (!Number.isSafeInteger(parsed) || parsed > maximum) {
        badRequest(`Invalid memory ${label}.`);
    }
    return parsed;
}

function date(value: string | undefined): string | undefined {
    if (value === undefined) return undefined;
    if (value.length > 64) badRequest('Invalid memory date filter.');
    const parsed = Date.parse(value);
    if (!Number.isFinite(parsed)) badRequest('Invalid memory date filter.');
    return new Date(parsed).toISOString();
}

function cursor(value: string | undefined): string | undefined {
    if (value === undefined) return undefined;
    if (!SAFE_CURSOR.test(value)) badRequest('Invalid memory cursor.');
    return value;
}

function validateDateRange(from: string | undefined, to: string | undefined): void {
    if (from && to && from > to) badRequest('Invalid memory date range.');
}
function isQueryCursorError(error: unknown): boolean {
    return error instanceof Error &&
        (error.message === 'Invalid memory cursor' ||
            error.message === 'Invalid memory event cursor');
}

async function respond(
    operation: () => Promise<unknown>,
): Promise<ControlCenterJsonResponseV1> {
    try {
        return { status: 200, body: await operation() };
    } catch (error) {
        if (error instanceof MemoryRequestError || isQueryCursorError(error)) {
            return { status: 400, body: { error: 'Invalid memory query.' } };
        }
        throw error;
    }
}

function parseGroups(context: ControlCenterRequestContextV1): MemoryGroupQuery {
    const values = valuesFor(context, [
        'projectId', 'scope', 'kind', 'reasonCode', 'lessonCode', 'sourceTool',
        'family', 'stageId', 'from', 'to', 'fingerprint', 'minOccurrences',
        'limit', 'cursor',
    ]);
    const from = date(values.from);
    const to = date(values.to);
    validateDateRange(from, to);
    const result: MemoryGroupQuery = {
        scope: scope(values.scope),
        limit: positiveInteger(values.limit, 'limit', MAX_LIMIT) ?? DEFAULT_LIMIT,
    };    const projectId = structural(values.projectId, 'project');
    if (result.scope === 'global' && projectId !== undefined) badRequest();
    const itemKind = kind(values.kind);
    const reasonCode = structural(values.reasonCode, 'reason code');
    const lessonCode = structural(values.lessonCode, 'lesson code');
    const sourceTool = structural(values.sourceTool, 'source tool');
    const family = structural(values.family, 'family');
    const stageId = structural(values.stageId, 'stage');
    const fingerprint = structural(values.fingerprint, 'fingerprint');
    const minOccurrences = positiveInteger(values.minOccurrences, 'minimum occurrences');
    const nextCursor = cursor(values.cursor);
    return {
        ...result,
        ...(projectId ? { projectId } : {}),
        ...(itemKind ? { kind: itemKind } : {}),
        ...(reasonCode ? { reasonCode } : {}),
        ...(lessonCode ? { lessonCode } : {}),
        ...(sourceTool ? { sourceTool } : {}),
        ...(family ? { family } : {}),
        ...(stageId ? { stageId } : {}),
        ...(from ? { from } : {}),
        ...(to ? { to } : {}),
        ...(fingerprint ? { fingerprint } : {}),
        ...(minOccurrences ? { minOccurrences } : {}),
        ...(nextCursor ? { cursor: nextCursor } : {}),
    };
}
function parseEvents(context: ControlCenterRequestContextV1): MemoryEventQuery {
    const values = valuesFor(context, [
        'projectId', 'workflowId', 'scope', 'from', 'to', 'limit', 'cursor',
    ]);
    const eventScope = scope(values.scope);
    const fingerprint = structural(context.params.fingerprint, 'fingerprint');
    if (!fingerprint) badRequest('Invalid memory fingerprint.');
    const projectId = structural(values.projectId, 'project');
    const workflowId = structural(values.workflowId, 'workflow');
    if (eventScope === 'global') {
        if (projectId !== undefined || workflowId !== undefined) badRequest();
    } else {
        if (!projectId) badRequest('Memory project is required.');
        if (eventScope === 'project' && workflowId !== undefined) badRequest();
        if (eventScope === 'workflow' && !workflowId) badRequest('Memory workflow is required.');
    }
    const from = date(values.from);
    const to = date(values.to);
    validateDateRange(from, to);
    const nextCursor = cursor(values.cursor);
    return {
        fingerprint,
        scope: eventScope,
        ...(projectId ? { projectId } : {}),
        ...(workflowId ? { workflowId } : {}),
        ...(from ? { from } : {}),
        ...(to ? { to } : {}),
        limit: positiveInteger(values.limit, 'limit', MAX_LIMIT) ?? DEFAULT_LIMIT,
        ...(nextCursor ? { cursor: nextCursor } : {}),
    };
}
async function handleOverview(
    context: ControlCenterRequestContextV1,
): Promise<ControlCenterJsonResponseV1> {
    return respond(async () => {
        valuesFor(context, []);
        return getOperationalMemoryOverview();
    });
}

async function handleGroups(
    context: ControlCenterRequestContextV1,
): Promise<ControlCenterJsonResponseV1> {
    return respond(() => queryOperationalMemoryGroups(parseGroups(context)));
}

async function handleEvents(
    context: ControlCenterRequestContextV1,
): Promise<ControlCenterJsonResponseV1> {
    return respond(() => queryOperationalMemoryEvents(parseEvents(context)));
}

async function handleFilterOptions(
    context: ControlCenterRequestContextV1,
): Promise<ControlCenterJsonResponseV1> {
    return respond(async () => {
        valuesFor(context, []);
        return getOperationalMemoryFilterOptions();
    });
}
export function createMemoryControlCenterExtension(): ControlCenterExtensionV1 {
    return {
        id: 'memory',
        apiPrefixes: [API_PREFIX],
        routes: [
            {
                method: 'GET',
                apiPrefix: API_PREFIX,
                path: '/overview',
                handle: handleOverview,
            },
            {
                method: 'GET',
                apiPrefix: API_PREFIX,
                path: '/groups',
                handle: handleGroups,
            },
            {
                method: 'GET',
                apiPrefix: API_PREFIX,
                path: '/groups/:fingerprint/events',
                handle: handleEvents,
            },
            {
                method: 'GET',
                apiPrefix: API_PREFIX,
                path: '/filter-options',
                handle: handleFilterOptions,
            },
        ],
    };
}
