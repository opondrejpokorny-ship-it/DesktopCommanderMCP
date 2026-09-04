import { execFile } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import type { ServerResult } from '../types.js';
import { validatePath } from '../tools/filesystem.js';
import {
    listActiveWork,
    type ActiveWorkEntry,
} from './active-work-registry.js';

export interface ActiveWorkEnforcementGateResult {
    allowed: boolean;
    result?: ServerResult;
}

function getStringArg(args: unknown, key: string): string | undefined {
    if (!args || typeof args !== 'object') return undefined;
    const value = (args as Record<string, unknown>)[key];
    return typeof value === 'string' ? value : undefined;
}

function mutatingFilesystemResources(tool: string, args: unknown): string[] {
    let resources: Array<string | undefined>;
    switch (tool) {
        case 'write_file':
        case 'create_directory':
        case 'delete_file': resources = [getStringArg(args, 'path')]; break;
        case 'edit_block': resources = [getStringArg(args, 'file_path')]; break;
        case 'move_file': resources = [getStringArg(args, 'source'), getStringArg(args, 'destination')]; break;
        case 'write_pdf': {
            const inputPath = getStringArg(args, 'path');
            resources = [getStringArg(args, 'outputPath') ?? inputPath];
            break;
        }
        default: resources = [];
    }
    return resources.filter((resource): resource is string => !!resource);
}

function normalizeComparablePath(value: string): string {
    let normalized = path.resolve(value);
    if (process.platform === 'win32') {
        normalized = normalized.toLowerCase();
    }
    return normalized;
}

function normalizeRepoRelative(value: string): string {
    return value
        .replace(/\\/g, '/')
        .replace(/^\.\/+/, '')
        .replace(/\/+/g, '/')
        .replace(/\/$/, '');
}

function normalizeComparableRepoRelative(value: string): string {
    const normalized = normalizeRepoRelative(value);
    return process.platform === 'win32' ? normalized.toLowerCase() : normalized;
}

function areaCoversPath(area: string, relativePath: string): boolean {
    const normalizedArea = normalizeComparableRepoRelative(area);
    const normalizedPath = normalizeComparableRepoRelative(relativePath);

    if (normalizedArea === '.' || normalizedArea === '*') {
        return true;
    }

    return (
        normalizedPath === normalizedArea ||
        normalizedPath.startsWith(normalizedArea + '/')
    );
}

function git(cwd: string, args: string[]): Promise<string> {
    return new Promise((resolve, reject) => {
        execFile(
            'git',
            ['-C', cwd, ...args],
            { encoding: 'utf8', windowsHide: true, maxBuffer: 1024 * 1024 },
            (error, stdout) => {
                if (error) {
                    reject(error);
                    return;
                }
                resolve((stdout ?? '').trim());
            },
        );
    });
}

async function nearestExistingDirectory(resource: string): Promise<string> {
    let current = resource;

    try {
        const stat = await fs.stat(current);
        if (!stat.isDirectory()) {
            current = path.dirname(current);
        }
    } catch {
        current = path.dirname(current);
    }

    while (true) {
        try {
            const stat = await fs.stat(current);
            if (stat.isDirectory()) {
                return current;
            }
        } catch {
            // Walk upward until an existing directory is found.
        }

        const parent = path.dirname(current);
        if (parent === current) {
            return current;
        }
        current = parent;
    }
}

async function findGitWorktreeRoot(
    resource: string,
): Promise<string | undefined> {
    const validated = await validatePath(resource);
    const probe = await nearestExistingDirectory(validated);

    try {
        const root = await git(probe, ['rev-parse', '--show-toplevel']);
        return validatePath(root);
    } catch {
        return undefined;
    }
}

function samePath(left: string, right: string): boolean {
    return normalizeComparablePath(left) === normalizeComparablePath(right);
}

function blockedResult(
    code:
        | 'ACTIVE_WORK_REGISTRATION_REQUIRED'
        | 'ACTIVE_WORK_SCOPE_UPDATE_REQUIRED'
        | 'ACTIVE_WORK_REGISTRY_CHECK_FAILED',
    resource: string,
    projectRoot: string,
    detail: string,
): ServerResult {
    return {
        content: [{
            type: 'text',
            text:
                code + ': ' + detail +
                ' No action was executed. Use active_work_registry before retrying.',
        }],
        structuredContent: {
            code,
            resource,
            projectRoot,
            requiredTool: 'active_work_registry',
        },
        isError: true,
    };
}

function worktreeEntries(
    entries: ActiveWorkEntry[],
    projectRoot: string,
): ActiveWorkEntry[] {
    return entries.filter((entry) => samePath(entry.worktreeRoot, projectRoot));
}

function entryCoversResource(
    entry: ActiveWorkEntry,
    projectRoot: string,
    resource: string,
): boolean {
    const relative = normalizeRepoRelative(path.relative(projectRoot, resource));

    if (
        relative === '..' ||
        relative.startsWith('../') ||
        path.isAbsolute(relative)
    ) {
        return false;
    }

    const target = relative || '.';
    return entry.affectedAreas.some((area) => areaCoversPath(area, target));
}

export async function applyActiveWorkEnforcementGate(
    tool: string,
    args: unknown,
): Promise<ActiveWorkEnforcementGateResult> {
    const resources = mutatingFilesystemResources(tool, args);

    if (resources.length === 0) {
        return { allowed: true };
    }

    for (const requestedResource of resources) {
        let resource: string;
        try {
            resource = await validatePath(requestedResource);
        } catch {
            // Let the existing policy/upstream path validation produce its own
            // authoritative error for invalid/disallowed resources.
            continue;
        }

        const projectRoot = await findGitWorktreeRoot(resource);
        if (!projectRoot) {
            continue;
        }

        let listed: Awaited<ReturnType<typeof listActiveWork>>;
        try {
            listed = await listActiveWork({ projectRoot });
        } catch (error) {
            const reason = error instanceof Error ? error.message : String(error);
            return {
                allowed: false,
                result: blockedResult(
                    'ACTIVE_WORK_REGISTRY_CHECK_FAILED',
                    resource,
                    projectRoot,
                    'Active Work Registry could not be verified (' +
                        reason +
                        '). Refusing repository mutation.',
                ),
            };
        }

        const entries = worktreeEntries(listed.entries, projectRoot);
        if (entries.length === 0) {
            return {
                allowed: false,
                result: blockedResult(
                    'ACTIVE_WORK_REGISTRATION_REQUIRED',
                    resource,
                    projectRoot,
                    'No active work entry exists for this Git worktree.',
                ),
            };
        }

        if (
            !entries.some((entry) =>
                entryCoversResource(entry, projectRoot, resource),
            )
        ) {
            return {
                allowed: false,
                result: blockedResult(
                    'ACTIVE_WORK_SCOPE_UPDATE_REQUIRED',
                    resource,
                    projectRoot,
                    'Active work exists for this worktree, but its affectedAreas do not cover the requested path.',
                ),
            };
        }
    }

    return { allowed: true };
}
