import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { USER_HOME } from '../config.js';
import { PolicyAction, PolicyDecision } from './types.js';

export type AuditEventType =
    | 'policy_decision'
    | 'approval_decision'
    | 'execution_result';

export interface AuditEventInput {
    type: AuditEventType;
    requestId: string;
    tool: string;
    action?: PolicyAction;
    resource?: string;
    deviceId?: string;
    decision?: PolicyDecision;
    ruleId?: string;
    approvalRequestId?: string;
    approvalDecision?: 'approved' | 'denied';
    outcome?: 'success' | 'failure';
    durationMs?: number;
}

export interface AuditEvent extends AuditEventInput {
    id: string;
    timestamp: string;
}

export const AUDIT_FILE = path.join(
    USER_HOME,
    '.claude-server-commander',
    'audit.jsonl',
);

function resolveAuditFile(auditPath?: string): string {
    return auditPath ?? process.env.DESKTOP_COMMANDER_AUDIT_FILE ?? AUDIT_FILE;
}

function safeResourceForAudit(tool: string, resource?: string): string | undefined {
    if (!resource) {
        return undefined;
    }

    const filesystemTools = new Set([
        'read_file',
        'write_file',
        'edit_block',
        'create_directory',
        'move_file',
        'delete_file',
    ]);

    return filesystemTools.has(tool) ? resource : undefined;
}

export async function appendAuditEvent(
    input: AuditEventInput,
    auditPath?: string,
): Promise<AuditEvent> {
    const record: AuditEvent = {
        ...input,
        ...(safeResourceForAudit(input.tool, input.resource)
            ? { resource: safeResourceForAudit(input.tool, input.resource) }
            : { resource: undefined }),
        id: crypto.randomUUID(),
        timestamp: new Date().toISOString(),
    };

    const filePath = resolveAuditFile(auditPath);
    await fs.mkdir(path.dirname(filePath), { recursive: true });
    await fs.appendFile(filePath, `${JSON.stringify(record)}\n`, 'utf8');
    return record;
}

export async function listAuditEvents(
    auditPath?: string,
    limit: number = 200,
): Promise<AuditEvent[]> {
    const filePath = resolveAuditFile(auditPath);

    let raw: string;
    try {
        raw = await fs.readFile(filePath, 'utf8');
    } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
            return [];
        }
        throw error;
    }

    const lines = raw
        .split(/\r?\n/)
        .filter((line) => line.trim().length > 0);

    return lines
        .slice(Math.max(0, lines.length - Math.max(0, limit)))
        .map((line) => JSON.parse(line) as AuditEvent);
}
