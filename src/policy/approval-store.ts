import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { USER_HOME } from '../config.js';
import { appendAuditEvent } from './audit-store.js';
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

function resolveApprovalFile(approvalPath?: string): string {
    return approvalPath ?? process.env.DESKTOP_COMMANDER_APPROVAL_FILE ?? APPROVAL_FILE;
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
}

export async function setApprovalDecision(
    requestId: string,
    decision: 'approved' | 'denied',
    approvalPath?: string,
    auditPath?: string,
): Promise<ApprovalRecord | null> {
    const store = await readStore(approvalPath);
    const changedByExpiry = expireOldApprovals(store);
    const record = store.approvals.find((entry) => entry.id === requestId);

    if (!record || record.status !== 'pending') {
        if (changedByExpiry) {
            await writeStore(store, approvalPath);
        }
        return null;
    }

    record.status = decision;
    record.decidedAt = new Date().toISOString();
    await writeStore(store, approvalPath);

    if (record.auditRequestId && record.action) {
        try {
            await appendAuditEvent(
                {
                    type: 'approval_decision',
                    requestId: record.auditRequestId,
                    tool: record.tool,
                    action: record.action,
                    resource: record.resource,
                    deviceId: record.deviceId,
                    ruleId: record.ruleId,
                    approvalRequestId: record.id,
                    approvalDecision: decision,
                },
                auditPath,
            );
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
}

export async function listApprovals(
    approvalPath?: string,
): Promise<ApprovalRecord[]> {
    const store = await readStore(approvalPath);

    if (expireOldApprovals(store)) {
        await writeStore(store, approvalPath);
    }

    return [...store.approvals];
}
