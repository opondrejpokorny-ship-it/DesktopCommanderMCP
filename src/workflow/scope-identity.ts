import crypto from 'node:crypto';
import { execFile } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import { validatePath } from '../tools/filesystem.js';

export const SCOPE_KINDS = ['rdc', 'project', 'task', 'action'] as const;
export type ScopeKind = (typeof SCOPE_KINDS)[number];
export type RepositoryId = string;
export type ProjectId = string;
export type TaskId = string;
export type RunId = string;
export type ActionId = string;

export interface RepositoryIdentity {
    repositoryId: RepositoryId;
    display: string;
    worktreeRoot: string;
    branch: string;
    head: string;
}

export interface ProjectIdentity {
    projectId: ProjectId;
    projectIdSource: 'repository_derived';
    repository: RepositoryIdentity;
}

function digest(value: string): string {
    return crypto.createHash('sha256').update(value, 'utf8').digest('hex');
}

function requirePathInput(value: unknown): string {
    if (typeof value !== 'string' || !value.trim()) {
        throw new Error('projectRoot must be a non-empty string');
    }
    const trimmed = value.trim();
    if (trimmed.length > 4000) {
        throw new Error('projectRoot is too long');
    }
    return trimmed;
}

function git(projectRoot: string, args: string[]): Promise<string> {
    return new Promise((resolve, reject) => {
        execFile(
            'git',
            ['-C', projectRoot, ...args],
            { encoding: 'utf8', windowsHide: true, maxBuffer: 1024 * 1024 },
            (error, stdout, stderr) => {
                if (error) {
                    const detail = typeof stderr === 'string' && stderr.trim()
                        ? ': ' + stderr.trim()
                        : '';
                    reject(new Error(
                        'Git inspection failed (' + (args[0] ?? 'command') + ')' + detail,
                    ));
                    return;
                }
                resolve((stdout ?? '').trim());
            },
        );
    });
}

async function gitOptional(
    projectRoot: string,
    args: string[],
): Promise<string | undefined> {
    try {
        const result = await git(projectRoot, args);
        return result || undefined;
    } catch {
        return undefined;
    }
}

async function resolveGitRoot(input: string): Promise<string> {
    const validated = await validatePath(requirePathInput(input));
    const root = await git(validated, ['rev-parse', '--show-toplevel']);
    return validatePath(root);
}

function normalizeRemote(remote: string): string | undefined {
    const trimmed = remote.trim();
    try {
        const parsed = new URL(trimmed);
        if (!parsed.hostname) {
            return undefined;
        }
        const repositoryPath = parsed.pathname
            .replace(/^\/+|\/+$/g, '')
            .replace(/\.git$/i, '');
        if (!repositoryPath) {
            return undefined;
        }
        return parsed.hostname.toLowerCase() + '/' + repositoryPath.toLowerCase();
    } catch {
        const scp = trimmed.match(/^(?:[^@/\s]+@)?([^:/\s]+):(.+)$/);
        if (!scp) {
            return undefined;
        }
        const repositoryPath = scp[2]
            .replace(/^\/+|\/+$/g, '')
            .replace(/\.git$/i, '');
        if (!repositoryPath) {
            return undefined;
        }
        return scp[1].toLowerCase() + '/' + repositoryPath.toLowerCase();
    }
}

async function localRepositoryIdentity(projectRoot: string): Promise<string> {
    const commonDir = await git(projectRoot, ['rev-parse', '--git-common-dir']);
    const absolute = path.resolve(projectRoot, commonDir);
    let canonical = absolute;
    try {
        canonical = await fs.realpath(absolute);
    } catch {
        // The normalized shared Git directory is still stable enough for this fallback.
    }
    if (process.platform === 'win32') {
        canonical = canonical.toLowerCase();
    }
    return 'local:' + digest(canonical);
}

export async function resolveRepositoryIdentity(input: string): Promise<RepositoryIdentity> {
    const projectRoot = await resolveGitRoot(input);
    const [head, branch, remoteList] = await Promise.all([
        git(projectRoot, ['rev-parse', 'HEAD']),
        gitOptional(projectRoot, ['symbolic-ref', '--short', 'HEAD']),
        gitOptional(projectRoot, ['remote']),
    ]);

    const remotes = (remoteList ?? '')
        .split(/\r?\n/)
        .map((item) => item.trim())
        .filter(Boolean);
    const preferred = remotes.includes('origin') ? 'origin' : remotes[0];
    let display: string | undefined;
    if (preferred) {
        const remote = await gitOptional(projectRoot, ['remote', 'get-url', preferred]);
        if (remote) {
            display = normalizeRemote(remote);
        }
    }

    const identity = display
        ? 'remote:' + display
        : await localRepositoryIdentity(projectRoot);

    return {
        repositoryId: digest(identity).slice(0, 24),
        display: display ?? 'local-repository',
        worktreeRoot: projectRoot,
        branch: branch ?? 'DETACHED',
        head,
    };
}

// This fallback is deterministic correlation metadata for one-repository projects.
// It is not authorization and may later be superseded by a server-owned Project Registry.
export function deriveProjectId(repositoryId: RepositoryId): ProjectId {
    if (!/^[a-f0-9]{24}$/.test(repositoryId)) {
        throw new Error('repositoryId must be a 24-character lowercase hex identifier');
    }
    return digest('project:' + repositoryId).slice(0, 24);
}

export async function resolveProjectIdentity(input: string): Promise<ProjectIdentity> {
    const repository = await resolveRepositoryIdentity(input);
    return {
        projectId: deriveProjectId(repository.repositoryId),
        projectIdSource: 'repository_derived',
        repository,
    };
}
