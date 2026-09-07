import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { USER_HOME } from '../config.js';
import type { AuditSink } from './audit-sink.js';
import { PolicyAction } from './types.js';

export type ApprovalStatus =
    | 'pending'
    | 'approved'
    | 'denied'
    | 'consumed'
    | 'expired';

export interface ApprovalRecord {
    id: string;
    fingerprint: string;
    tool: string;
    ruleId?: string;
    resource?: string;
    action?: PolicyAction;
    deviceId?: string;
    auditRequestId?: string;
    status: ApprovalStatus;
    createdAt: string;
    expiresAt: string;
    decidedAt?: string;
    consumedAt?: string;
}

interface ApprovalStoreFile {
    version: 1;
    approvals: ApprovalRecord[];
}

export interface PendingApprovalInput {
    tool: string;
    args: unknown;
    ruleId?: string;
    resource?: string;
    action?: PolicyAction;
    deviceId?: string;
    auditRequestId?: string;
    ttlMs?: number;
}

export const APPROVAL_FILE = path.join(
    USER_HOME,
    '.claude-server-commander',
    'approvals.json',
);

const DEFAULT_TTL_MS = 5 * 60 * 1000;
const LOCK_RETRY_MS = 25;
const LOCK_ATTEMPTS = 200;
const STALE_LOCK_MS = 30_000;

function resolveApprovalFile(approvalPath?: string): string {
    return approvalPath ?? process.env.DESKTOP_COMMANDER_APPROVAL_FILE ?? APPROVAL_FILE;
}

async function recoverStaleApprovalLock(lockPath: string): Promise<boolean> {
    const stat = await fs.stat(lockPath).catch((error) => {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
        throw error;
    });
    if (!stat) return true;
    if (Date.now() - stat.mtimeMs <= STALE_LOCK_MS) return false;

    const reclaimedPath = `${lockPath}.stale-${process.pid}-${crypto.randomUUID()}`;
    try {
        await fs.rename(lockPath, reclaimedPath);
    } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return true;
        throw error;
    }
    await fs.rm(reclaimedPath, { recursive: true, force: true }).catch(() => undefined);
    return true;
}

async function withApprovalStoreLock<T>(
    approvalPath: string | undefined,
    operation: () => Promise<T>,
): Promise<T> {
    const filePath = resolveApprovalFile(approvalPath);
    const lockPath = `${filePath}.lock`;
    await fs.mkdir(path.dirname(lockPath), { recursive: true });
    let acquired = false;

    for (let attempt = 0; attempt < LOCK_ATTEMPTS; attempt += 1) {
        try {
            await fs.mkdir(lockPath);
            acquired = true;
            break;
        } catch (error) {
            if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
            try {
                const stat = await fs.stat(lockPath);
                if (Date.now() - stat.mtimeMs > STALE_LOCK_MS) {
                    if (await recoverStaleApprovalLock(lockPath)) continue;
                }
            } catch (statError) {
                if ((statError as NodeJS.ErrnoException).code !== 'ENOENT') throw statError;
            }
            await delay(LOCK_RETRY_MS);
        }
    }

    if (!acquired) {
        throw new Error('Desktop Commander approval store is busy; refusing an unsafe concurrent write');
    }

    try {
        return await operation();
    } finally {
        await fs.rm(lockPath, { recursive: true, force: true }).catch(() => undefined);
    }
}

function stableValue(value: unknown): unknown {
    if (Array.isArray(value)) {
        return value.map(stableValue);
    }

    if (value && typeof value === 'object') {
        const source = value as Record<string, unknown>;
        return Object.fromEntries(
            Object.keys(source)
                .sort()
                .map((key) => [key, stableValue(source[key])]),
        );
    }

    return value;
}

export function fingerprintAction(tool: string, args: unknown): string {
    const canonical = JSON.stringify(stableValue({ tool, args }));
    return crypto.createHash('sha256').update(canonical).digest('hex');
}

function safeResourceForStore(tool: string, resource?: string): string | undefined {
    if (!resource) {
        return undefined;
    }

    // Persist paths for filesystem approvals so the user can understand what is
    // being approved. Do not persist terminal command text: commands can embed
    // tokens, passwords, or other secrets.
    const filesystemTools = new Set([
        'write_file',
        'edit_block',
        'create_directory',
        'move_file',
        'delete_file',
    ]);

    return filesystemTools.has(tool) ? resource : undefined;
}

async function readStore(approvalPath?: string): Promise<ApprovalStoreFile> {
    const filePath = resolveApprovalFile(approvalPath);

    try {
        const raw = await fs.readFile(filePath, 'utf8');
        const parsed = JSON.parse(raw) as ApprovalStoreFile;

        if (parsed.version !== 1 || !Array.isArray(parsed.approvals)) {
            throw new Error('unsupported approval store format');
        }

        return parsed;
    } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
            return { version: 1, approvals: [] };
        }

        const reason = error instanceof Error ? error.message : String(error);
        throw new Error(`Invalid Desktop Commander approval store: ${reason}`);
    }
}

async function writeStore(
    store: ApprovalStoreFile,
    approvalPath?: string,
): Promise<void> {
    const filePath = resolveApprovalFile(approvalPath);
    await fs.mkdir(path.dirname(filePath), { recursive: true });
    await fs.writeFile(filePath, JSON.stringify(store, null, 2), 'utf8');
}

function expireOldApprovals(store: ApprovalStoreFile): boolean {
    const now = Date.now();
    let changed = false;

    for (const record of store.approvals) {
        if (
            (record.status === 'pending' || record.status === 'approved') &&
            Date.parse(record.expiresAt) <= now
        ) {
            record.status = 'expired';
            changed = true;
        }
    }

    return changed;
}

export async function createPendingApproval(
    input: PendingApprovalInput,
    approvalPath?: string,
): Promise<ApprovalRecord> {
    return withApprovalStoreLock(approvalPath, async () => {
        const store = await readStore(approvalPath);
        expireOldApprovals(store);

        const fingerprint = fingerprintAction(input.tool, input.args);
        const existing = store.approvals.find(
            (record) =>
                record.status === 'pending' &&
                record.fingerprint === fingerprint &&
                record.ruleId === input.ruleId,
        );

        if (existing) {
            await writeStore(store, approvalPath);
            return existing;
        }

        const now = Date.now();
        const safeResource = safeResourceForStore(input.tool, input.resource);
        const record: ApprovalRecord = {
            id: crypto.randomUUID(),
            fingerprint,
            tool: input.tool,
            ...(input.ruleId ? { ruleId: input.ruleId } : {}),
            ...(safeResource ? { resource: safeResource } : {}),
            ...(input.action ? { action: input.action } : {}),
            ...(input.deviceId ? { deviceId: input.deviceId } : {}),
            ...(input.auditRequestId ? { auditRequestId: input.auditRequestId } : {}),
            status: 'pending',
            createdAt: new Date(now).toISOString(),
            expiresAt: new Date(now + (input.ttlMs ?? DEFAULT_TTL_MS)).toISOString(),
        };

        store.approvals.push(record);
        await writeStore(store, approvalPath);
        return record;
    });
}

export async function setApprovalDecision(
    requestId: string,
    decision: 'approved' | 'denied',
    approvalPath?: string,
    auditSink?: AuditSink,
): Promise<ApprovalRecord | null> {
    const record = await withApprovalStoreLock(approvalPath, async () => {
        const store = await readStore(approvalPath);
        const changedByExpiry = expireOldApprovals(store);
        const matched = store.approvals.find((entry) => entry.id === requestId);

        if (!matched || matched.status !== 'pending') {
            if (changedByExpiry) {
                await writeStore(store, approvalPath);
            }
            return null;
        }

        matched.status = decision;
        matched.decidedAt = new Date().toISOString();
        await writeStore(store, approvalPath);
        return matched;
    });

    if (record?.auditRequestId && record.action) {
        try {
            await auditSink?.append({
                    type: 'approval_decision',
                    requestId: record.auditRequestId,
                    tool: record.tool,
                    action: record.action,
                    resource: record.resource,
                    deviceId: record.deviceId,
                    ruleId: record.ruleId,
                    approvalRequestId: record.id,
                    approvalDecision: decision,
                });
        } catch (error) {
            // The approval decision itself is authoritative; a logging failure
            // must not undo or silently change the user's decision.
            console.error(
                'Desktop Commander prototype approval audit write failed:',
                error instanceof Error ? error.message : String(error),
            );
        }
    }

    return record;
}

export async function consumeApprovedAction(
    tool: string,
    args: unknown,
    approvalPath?: string,
    ruleId?: string,
): Promise<ApprovalRecord | null> {
    return withApprovalStoreLock(approvalPath, async () => {
        const store = await readStore(approvalPath);
        const changedByExpiry = expireOldApprovals(store);
        const fingerprint = fingerprintAction(tool, args);

        const record = store.approvals.find(
            (entry) =>
                entry.status === 'approved' &&
                entry.fingerprint === fingerprint &&
                (ruleId === undefined || entry.ruleId === ruleId),
        );

        if (!record) {
            if (changedByExpiry) {
                await writeStore(store, approvalPath);
            }
            return null;
        }

        record.status = 'consumed';
        record.consumedAt = new Date().toISOString();
        await writeStore(store, approvalPath);
        return record;
    });
}

export async function listApprovals(
    approvalPath?: string,
): Promise<ApprovalRecord[]> {
    return withApprovalStoreLock(approvalPath, async () => {
        const store = await readStore(approvalPath);

        if (expireOldApprovals(store)) {
            await writeStore(store, approvalPath);
        }

        return [...store.approvals];
    });
}
