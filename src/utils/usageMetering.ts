import fs from 'fs/promises';
import os from 'os';
import path from 'path';
import type { ServerResult } from '../types.js';

export interface UsageMeterState {
    returnedBytes: number;
    writtenBytes: number;
    periodStartedAt: string | null;
}

export interface UsageDelta {
    returnedBytes?: number;
    writtenBytes?: number;
}

const DEFAULT_USAGE_FILE = path.join(
    os.homedir(),
    '.claude-server-commander',
    'usage-meter.json',
);

let mutationQueue: Promise<unknown> = Promise.resolve();

const LOCK_STALE_MS = 30_000;
const LOCK_TIMEOUT_MS = 5_000;
const LOCK_RETRY_MS = 10;

function resolveUsageFilePath(filePath?: string): string {
    return filePath
        ?? process.env.DESKTOP_COMMANDER_USAGE_FILE
        ?? DEFAULT_USAGE_FILE;
}

async function acquireUsageLock(filePath: string): Promise<() => Promise<void>> {
    const lockPath = filePath + '.lock';
    const startedAt = Date.now();
    await fs.mkdir(path.dirname(filePath), { recursive: true });

    while (true) {
        try {
            const handle = await fs.open(lockPath, 'wx');
            return async () => {
                await handle.close();
                await fs.rm(lockPath, { force: true });
            };
        } catch (error) {
            const code = (error as NodeJS.ErrnoException).code;
            if (code !== 'EEXIST') throw error;

            try {
                const stats = await fs.stat(lockPath);
                if (Date.now() - stats.mtimeMs > LOCK_STALE_MS) {
                    await fs.rm(lockPath, { force: true });
                    continue;
                }
            } catch (statError) {
                if ((statError as NodeJS.ErrnoException).code === 'ENOENT') {
                    continue;
                }
                throw statError;
            }

            if (Date.now() - startedAt >= LOCK_TIMEOUT_MS) {
                throw new Error('Usage meter lock timed out');
            }
            await new Promise((resolve) => setTimeout(resolve, LOCK_RETRY_MS));
        }
    }
}

function emptyUsageState(): UsageMeterState {
    return {
        returnedBytes: 0,
        writtenBytes: 0,
        periodStartedAt: null,
    };
}

function isNonNegativeSafeInteger(value: unknown): value is number {
    return Number.isSafeInteger(value) && Number(value) >= 0;
}

function parseUsageState(raw: string): UsageMeterState {
    let parsed: unknown;
    try {
        parsed = JSON.parse(raw);
    } catch {
        throw new Error('Invalid usage meter JSON');
    }

    if (!parsed || typeof parsed !== 'object') {
        throw new Error('Invalid usage meter state');
    }

    const value = parsed as Record<string, unknown>;
    const startedAt = value.periodStartedAt;
    if (!isNonNegativeSafeInteger(value.returnedBytes)
        || !isNonNegativeSafeInteger(value.writtenBytes)
        || (startedAt !== null && (
            typeof startedAt !== 'string'
            || Number.isNaN(Date.parse(startedAt))
        ))) {
        throw new Error('Invalid usage meter fields');
    }
    return {
        returnedBytes: value.returnedBytes,
        writtenBytes: value.writtenBytes,
        periodStartedAt: startedAt as string | null,
    };
}

export async function loadUsageMeter(filePath?: string): Promise<UsageMeterState> {
    const resolvedPath = resolveUsageFilePath(filePath);
    try {
        return parseUsageState(await fs.readFile(resolvedPath, 'utf8'));
    } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
            return emptyUsageState();
        }
        throw error;
    }
}

async function writeUsageState(
    state: UsageMeterState,
    filePath: string,
): Promise<void> {
    await fs.mkdir(path.dirname(filePath), { recursive: true });
    const tempPath = filePath + '.tmp-' + process.pid + '-' + Date.now();
    try {
        await fs.writeFile(tempPath, JSON.stringify(state, null, 2), 'utf8');
        try {
            await fs.rename(tempPath, filePath);
        } catch (error) {
            if ((error as NodeJS.ErrnoException).code !== 'EPERM') throw error;
            await fs.rm(filePath, { force: true });
            await fs.rename(tempPath, filePath);
        }
    } finally {
        await fs.rm(tempPath, { force: true }).catch(() => undefined);
    }
}

function normalizeDelta(value: number | undefined, field: string): number {
    const normalized = value ?? 0;
    if (!isNonNegativeSafeInteger(normalized)) {
        throw new Error('Invalid usage delta for ' + field);
    }
    return normalized;
}

async function recordUsageUnlocked(
    delta: UsageDelta,
    filePath?: string,
): Promise<UsageMeterState> {
    const returnedDelta = normalizeDelta(delta.returnedBytes, 'returnedBytes');
    const writtenDelta = normalizeDelta(delta.writtenBytes, 'writtenBytes');
    const resolvedPath = resolveUsageFilePath(filePath);
    const releaseLock = await acquireUsageLock(resolvedPath);

    try {
        const current = await loadUsageMeter(resolvedPath);
        const next: UsageMeterState = {
            returnedBytes: current.returnedBytes + returnedDelta,
            writtenBytes: current.writtenBytes + writtenDelta,
            periodStartedAt: current.periodStartedAt
                ?? new Date().toISOString(),
        };

        if (!Number.isSafeInteger(next.returnedBytes)
            || !Number.isSafeInteger(next.writtenBytes)) {
            throw new Error('Usage meter overflow');
        }

        await writeUsageState(next, resolvedPath);
        return next;
    } finally {
        await releaseLock();
    }
}

export function recordUsage(
    delta: UsageDelta,
    filePath?: string,
): Promise<UsageMeterState> {
    const operation = () => recordUsageUnlocked(delta, filePath);
    const next = mutationQueue.then(operation, operation);
    mutationQueue = next.then(() => undefined, () => undefined);
    return next;
}

export function calculateReturnedBytes(result: ServerResult): number {
    return Buffer.byteLength(JSON.stringify(result), 'utf8');
}

function payloadBytes(value: unknown): number {
    if (typeof value === 'string') {
        return Buffer.byteLength(value, 'utf8');
    }
    if (value === undefined || value === null) {
        return 0;
    }
    return Buffer.byteLength(JSON.stringify(value), 'utf8');
}

export function calculateWritePayloadBytes(
    toolName: string,
    args: unknown,
): number {
    if (!args || typeof args !== 'object') return 0;
    const value = args as Record<string, unknown>;

    switch (toolName) {
        case 'write_file':
        case 'write_pdf':
            return payloadBytes(value.content);
        case 'edit_block':
            return payloadBytes(value.new_string ?? value.content);
        default:
            return 0;
    }
}
