import crypto from 'node:crypto';
import { execFile } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { validatePath } from '../tools/filesystem.js';
import { resolveWorkflowStateRoot } from './workflow-storage.js';

export type ActiveWorkGuidance =
    | 'safe_parallel'
    | 'continue_existing'
    | 'wait_or_read_only';

export type ActiveWorkConflictReason =
    | 'same_task'
    | 'affected_area_overlap'
    | 'risk_area_overlap';

export interface ActiveWorkRepository {
    id: string;
    display: string;
    worktreeRoot: string;
    branch: string;
    head: string;
}

export interface ActiveWorkEntry {
    id: string;
    repositoryId: string;
    repositoryDisplay: string;
    worktreeRoot: string;
    branch: string;
    head: string;
    title: string;
    scope: string;
    affectedAreas: string[];
    riskAreas: string[];
    target?: string;
    safeParallelWork: string[];
    nextAction?: string;
    conflictRisk?: string;
    intentFingerprint: string;
    startedAt: string;
    updatedAt: string;
}

export interface ActiveWorkConflict {
    entry: ActiveWorkEntry;
    reasons: ActiveWorkConflictReason[];
}

export interface CheckActiveWorkInput {
    projectRoot: string;
    title: string;
    scope: string;
    affectedAreas: string[];
    riskAreas?: string[];
}

export interface RegisterActiveWorkInput extends CheckActiveWorkInput {
    target?: string;
    safeParallelWork?: string[];
    nextAction?: string;
    conflictRisk?: string;
}

export interface ListActiveWorkInput {
    projectRoot: string;
}

export interface UpdateActiveWorkInput extends ListActiveWorkInput {
    entryId: string;
    title?: string;
    scope?: string;
    affectedAreas?: string[];
    riskAreas?: string[];
    target?: string;
    safeParallelWork?: string[];
    nextAction?: string;
    conflictRisk?: string;
}

export interface RemoveActiveWorkInput extends ListActiveWorkInput {
    entryId: string;
}

export interface ActiveWorkCheckResult {
    repository: ActiveWorkRepository;
    guidance: ActiveWorkGuidance;
    conflicts: ActiveWorkConflict[];
    entries: ActiveWorkEntry[];
}

export interface ActiveWorkRegisterResult extends ActiveWorkCheckResult {
    registered: boolean;
    entry?: ActiveWorkEntry;
}

export interface ActiveWorkListResult {
    repository: ActiveWorkRepository;
    entries: ActiveWorkEntry[];
}

export interface ActiveWorkUpdateResult extends ActiveWorkListResult {
    entry: ActiveWorkEntry;
}

export interface ActiveWorkRemoveResult extends ActiveWorkListResult {
    removed: boolean;
    entryId: string;
}

interface ActiveWorkRegistryState {
    version: 1;
    entries: ActiveWorkEntry[];
}

interface CandidateWork {
    title: string;
    scope: string;
    affectedAreas: string[];
    riskAreas: string[];
    intentFingerprint: string;
}

const MAX_TEXT = 2000;
const MAX_ENTRIES = 200;
const LOCK_RETRY_MS = 25;
const LOCK_ATTEMPTS = 200;
const STALE_LOCK_MS = 30_000;

function now(): string {
    return new Date().toISOString();
}

function digest(value: string): string {
    return crypto.createHash('sha256').update(value, 'utf8').digest('hex');
}

function safeText(value: unknown, label: string, max = MAX_TEXT): string {
    if (typeof value !== 'string' || !value.trim()) {
        throw new Error(label + ' must be a non-empty string');
    }
    let text = value.trim()
        .replace(/\bgh[pousr]_[A-Za-z0-9_]{8,}\b/g, '[REDACTED]')
        .replace(/\bsk-[A-Za-z0-9_-]{8,}\b/g, '[REDACTED]')
        .replace(/\bBearer\s+[A-Za-z0-9._~+/=-]+/gi, 'Bearer [REDACTED]')
        .replace(
            /((?:token|password|secret|api[_-]?key)\s*[:=]\s*)[^\s,;]+/gi,
            '$1[REDACTED]',
        )
        .replace(
            /([?&](?:token|password|secret|api[_-]?key)=)[^&#\s]+/gi,
            '$1[REDACTED]',
        );
    if (text.length > max) {
        text = text.slice(0, max) + '…';
    }
    return text;
}

function cleanArea(value: unknown, label: string): string {
    const cleaned = safeText(value, label, 500)
        .replace(/\\/g, '/')
        .replace(/^\.\/+/, '')
        .replace(/\/+/g, '/')
        .replace(/\/$/, '');
    if (
        !cleaned ||
        cleaned.startsWith('/') ||
        /^[A-Za-z]:\//.test(cleaned) ||
        cleaned.split('/').includes('..')
    ) {
        throw new Error(label + ' must be a repository-relative area');
    }
    return cleaned;
}

function cleanAreas(
    value: unknown,
    label: string,
    required: boolean,
): string[] {
    if (value === undefined && !required) {
        return [];
    }
    if (!Array.isArray(value) || (required && value.length === 0) || value.length > 100) {
        throw new Error(label + ' must contain ' + (required ? '1-100' : '0-100') + ' items');
    }
    return [...new Set(value.map((item, index) => cleanArea(item, label + '[' + index + ']')))];
}

function cleanRiskAreas(value: unknown): string[] {
    if (value === undefined) {
        return [];
    }
    if (!Array.isArray(value) || value.length > 100) {
        throw new Error('riskAreas must contain 0-100 items');
    }
    return [...new Set(
        value.map((item, index) =>
            safeText(item, 'riskAreas[' + index + ']', 200).toLowerCase(),
        ),
    )];
}

function cleanTextList(value: unknown, label: string): string[] {
    if (value === undefined) {
        return [];
    }
    if (!Array.isArray(value) || value.length > 100) {
        throw new Error(label + ' must contain 0-100 items');
    }
    return value.map((item, index) => safeText(item, label + '[' + index + ']', 1000));
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
    const validated = await validatePath(safeText(input, 'projectRoot', 4000));
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

async function inspectRepository(input: string): Promise<ActiveWorkRepository> {
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
        id: digest(identity).slice(0, 24),
        display: display ?? 'local-repository',
        worktreeRoot: projectRoot,
        branch: branch ?? 'DETACHED',
        head,
    };
}

export function resolveActiveWorkRegistryPath(): string {
    return path.join(resolveWorkflowStateRoot(), 'active-work-registry.json');
}

function registryLockPath(): string {
    return resolveActiveWorkRegistryPath() + '.lock';
}

function parseRegistry(value: unknown): ActiveWorkRegistryState {
    if (!value || typeof value !== 'object') {
        throw new Error('active work registry root must be an object');
    }
    const raw = value as Record<string, unknown>;
    if (raw.version !== 1 || !Array.isArray(raw.entries)) {
        throw new Error('active work registry is invalid or incomplete');
    }
    if (raw.entries.length > MAX_ENTRIES) {
        throw new Error('active work registry exceeds the supported entry limit');
    }
    for (const [index, item] of raw.entries.entries()) {
        if (!item || typeof item !== 'object') {
            throw new Error('active work registry entry is invalid: ' + index);
        }
        const entry = item as Record<string, unknown>;
        for (const key of [
            'id',
            'repositoryId',
            'repositoryDisplay',
            'worktreeRoot',
            'branch',
            'head',
            'title',
            'scope',
            'intentFingerprint',
            'startedAt',
            'updatedAt',
        ]) {
            if (typeof entry[key] !== 'string' || !(entry[key] as string).trim()) {
                throw new Error('active work registry entry is invalid: ' + index + '.' + key);
            }
        }
        for (const key of ['affectedAreas', 'riskAreas', 'safeParallelWork']) {
            if (!Array.isArray(entry[key])) {
                throw new Error('active work registry entry is invalid: ' + index + '.' + key);
            }
        }
    }
    return raw as unknown as ActiveWorkRegistryState;
}

async function readRegistry(): Promise<ActiveWorkRegistryState> {
    const registryPath = resolveActiveWorkRegistryPath();
    let text: string;
    try {
        text = await fs.readFile(registryPath, 'utf8');
    } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
            return { version: 1, entries: [] };
        }
        throw error;
    }
    try {
        return parseRegistry(JSON.parse(text));
    } catch (error) {
        throw new Error(
            'Invalid active work registry. Refusing to continue: ' +
                (error instanceof Error ? error.message : String(error)),
        );
    }
}

async function writeRegistry(state: ActiveWorkRegistryState): Promise<void> {
    const registryPath = resolveActiveWorkRegistryPath();
    await fs.mkdir(path.dirname(registryPath), { recursive: true });
    const tempPath =
        registryPath + '.tmp-' + process.pid + '-' + crypto.randomUUID();
    try {
        await fs.writeFile(tempPath, JSON.stringify(state, null, 2), 'utf8');
        try {
            await fs.rename(tempPath, registryPath);
        } catch (error) {
            if ((error as NodeJS.ErrnoException).code !== 'EPERM') {
                throw error;
            }
            await fs.rm(registryPath, { force: true });
            await fs.rename(tempPath, registryPath);
        }
    } finally {
        await fs.rm(tempPath, { force: true }).catch(() => undefined);
    }
}

async function withRegistryLock<T>(operation: () => Promise<T>): Promise<T> {
    const lockPath = registryLockPath();
    await fs.mkdir(path.dirname(lockPath), { recursive: true });
    let acquired = false;

    for (let attempt = 0; attempt < LOCK_ATTEMPTS; attempt += 1) {
        try {
            await fs.mkdir(lockPath);
            acquired = true;
            break;
        } catch (error) {
            if ((error as NodeJS.ErrnoException).code !== 'EEXIST') {
                throw error;
            }
            try {
                const stat = await fs.stat(lockPath);
                if (Date.now() - stat.mtimeMs > STALE_LOCK_MS) {
                    await fs.rm(lockPath, { recursive: true, force: true });
                    continue;
                }
            } catch (statError) {
                if ((statError as NodeJS.ErrnoException).code !== 'ENOENT') {
                    throw statError;
                }
            }
            await delay(LOCK_RETRY_MS);
        }
    }

    if (!acquired) {
        throw new Error('Active work registry is busy; refusing an unsafe concurrent write');
    }

    try {
        return await operation();
    } finally {
        await fs.rm(lockPath, { recursive: true, force: true }).catch(() => undefined);
    }
}

function intentFingerprint(title: string, scope: string): string {
    return digest(title.toLowerCase() + '\n' + scope.toLowerCase()).slice(0, 32);
}

function toCandidate(input: CheckActiveWorkInput): CandidateWork {
    const title = safeText(input.title, 'title', 300);
    const scope = safeText(input.scope, 'scope', 2000);
    return {
        title,
        scope,
        affectedAreas: cleanAreas(input.affectedAreas, 'affectedAreas', true),
        riskAreas: cleanRiskAreas(input.riskAreas),
        intentFingerprint: intentFingerprint(title, scope),
    };
}

function areaKey(area: string): string {
    return area.toLowerCase();
}

function areasOverlap(left: string, right: string): boolean {
    const a = areaKey(left);
    const b = areaKey(right);
    return a === b || a.startsWith(b + '/') || b.startsWith(a + '/');
}

function assess(
    candidate: CandidateWork,
    entries: ActiveWorkEntry[],
): {
    guidance: ActiveWorkGuidance;
    conflicts: ActiveWorkConflict[];
} {
    const conflicts: ActiveWorkConflict[] = [];

    for (const entry of entries) {
        const reasons: ActiveWorkConflictReason[] = [];
        if (entry.intentFingerprint === candidate.intentFingerprint) {
            reasons.push('same_task');
        }
        if (
            candidate.affectedAreas.some((candidateArea) =>
                entry.affectedAreas.some((existingArea) =>
                    areasOverlap(candidateArea, existingArea),
                ),
            )
        ) {
            reasons.push('affected_area_overlap');
        }
        if (
            candidate.riskAreas.some((risk) =>
                entry.riskAreas.some((existingRisk) => existingRisk === risk),
            )
        ) {
            reasons.push('risk_area_overlap');
        }
        if (reasons.length > 0) {
            conflicts.push({ entry, reasons });
        }
    }

    if (conflicts.some((conflict) => conflict.reasons.includes('same_task'))) {
        return { guidance: 'continue_existing', conflicts };
    }
    if (conflicts.length > 0) {
        return { guidance: 'wait_or_read_only', conflicts };
    }
    return { guidance: 'safe_parallel', conflicts: [] };
}

function entriesForRepository(
    state: ActiveWorkRegistryState,
    repositoryId: string,
): ActiveWorkEntry[] {
    return state.entries.filter((entry) => entry.repositoryId === repositoryId);
}

export async function checkActiveWork(
    input: CheckActiveWorkInput,
): Promise<ActiveWorkCheckResult> {
    const repository = await inspectRepository(input.projectRoot);
    const candidate = toCandidate(input);
    return withRegistryLock(async () => {
        const state = await readRegistry();
        const entries = entriesForRepository(state, repository.id);
        const result = assess(candidate, entries);
        return { repository, ...result, entries };
    });
}

export async function registerActiveWork(
    input: RegisterActiveWorkInput,
): Promise<ActiveWorkRegisterResult> {
    const repository = await inspectRepository(input.projectRoot);
    const candidate = toCandidate(input);

    return withRegistryLock(async () => {
        const state = await readRegistry();
        const entries = entriesForRepository(state, repository.id);
        const result = assess(candidate, entries);
        if (result.guidance !== 'safe_parallel') {
            const sameTask = result.conflicts.find((conflict) =>
                conflict.reasons.includes('same_task'),
            );
            return {
                repository,
                ...result,
                entries,
                registered: false,
                ...(sameTask ? { entry: sameTask.entry } : {}),
            };
        }
        if (state.entries.length >= MAX_ENTRIES) {
            throw new Error('Active work registry is full; refusing to discard existing work');
        }

        const timestamp = now();
        const entry: ActiveWorkEntry = {
            id: crypto.randomUUID(),
            repositoryId: repository.id,
            repositoryDisplay: repository.display,
            worktreeRoot: safeText(repository.worktreeRoot, 'worktreeRoot', 4000),
            branch: safeText(repository.branch, 'branch', 500),
            head: safeText(repository.head, 'head', 100),
            title: candidate.title,
            scope: candidate.scope,
            affectedAreas: candidate.affectedAreas,
            riskAreas: candidate.riskAreas,
            ...(input.target !== undefined
                ? { target: safeText(input.target, 'target', 500) }
                : {}),
            safeParallelWork: cleanTextList(
                input.safeParallelWork,
                'safeParallelWork',
            ),
            ...(input.nextAction !== undefined
                ? { nextAction: safeText(input.nextAction, 'nextAction', 2000) }
                : {}),
            ...(input.conflictRisk !== undefined
                ? { conflictRisk: safeText(input.conflictRisk, 'conflictRisk', 2000) }
                : {}),
            intentFingerprint: candidate.intentFingerprint,
            startedAt: timestamp,
            updatedAt: timestamp,
        };

        const nextState: ActiveWorkRegistryState = {
            version: 1,
            entries: [...state.entries, entry],
        };
        await writeRegistry(nextState);
        return {
            repository,
            guidance: 'safe_parallel',
            conflicts: [],
            entries: entriesForRepository(nextState, repository.id),
            registered: true,
            entry,
        };
    });
}

export async function listActiveWork(
    input: ListActiveWorkInput,
): Promise<ActiveWorkListResult> {
    const repository = await inspectRepository(input.projectRoot);
    return withRegistryLock(async () => {
        const state = await readRegistry();
        return {
            repository,
            entries: entriesForRepository(state, repository.id),
        };
    });
}

export async function updateActiveWork(
    input: UpdateActiveWorkInput,
): Promise<ActiveWorkUpdateResult> {
    const repository = await inspectRepository(input.projectRoot);
    const entryId = safeText(input.entryId, 'entryId', 200);

    return withRegistryLock(async () => {
        const state = await readRegistry();
        const index = state.entries.findIndex(
            (entry) =>
                entry.id === entryId && entry.repositoryId === repository.id,
        );
        if (index < 0) {
            throw new Error('Active work entry not found for this repository');
        }

        const current = state.entries[index];
        const title =
            input.title !== undefined
                ? safeText(input.title, 'title', 300)
                : current.title;
        const scope =
            input.scope !== undefined
                ? safeText(input.scope, 'scope', 2000)
                : current.scope;
        const affectedAreas =
            input.affectedAreas !== undefined
                ? cleanAreas(input.affectedAreas, 'affectedAreas', true)
                : current.affectedAreas;
        const riskAreas =
            input.riskAreas !== undefined
                ? cleanRiskAreas(input.riskAreas)
                : current.riskAreas;

        const updated: ActiveWorkEntry = {
            ...current,
            worktreeRoot: safeText(repository.worktreeRoot, 'worktreeRoot', 4000),
            branch: safeText(repository.branch, 'branch', 500),
            head: safeText(repository.head, 'head', 100),
            title,
            scope,
            affectedAreas,
            riskAreas,
            ...(input.target !== undefined
                ? { target: safeText(input.target, 'target', 500) }
                : {}),
            ...(input.safeParallelWork !== undefined
                ? {
                    safeParallelWork: cleanTextList(
                        input.safeParallelWork,
                        'safeParallelWork',
                    ),
                }
                : {}),
            ...(input.nextAction !== undefined
                ? { nextAction: safeText(input.nextAction, 'nextAction', 2000) }
                : {}),
            ...(input.conflictRisk !== undefined
                ? {
                    conflictRisk: safeText(
                        input.conflictRisk,
                        'conflictRisk',
                        2000,
                    ),
                }
                : {}),
            intentFingerprint: intentFingerprint(title, scope),
            updatedAt: now(),
        };

        const otherEntries = state.entries.filter(
            (entry, otherIndex) =>
                otherIndex !== index && entry.repositoryId === repository.id,
        );
        const conflict = assess(
            {
                title: updated.title,
                scope: updated.scope,
                affectedAreas: updated.affectedAreas,
                riskAreas: updated.riskAreas,
                intentFingerprint: updated.intentFingerprint,
            },
            otherEntries,
        );
        if (conflict.guidance !== 'safe_parallel') {
            throw new Error(
                'Active work update would overlap another entry; check the registry first',
            );
        }

        const nextEntries = [...state.entries];
        nextEntries[index] = updated;
        const nextState: ActiveWorkRegistryState = {
            version: 1,
            entries: nextEntries,
        };
        await writeRegistry(nextState);
        return {
            repository,
            entry: updated,
            entries: entriesForRepository(nextState, repository.id),
        };
    });
}

export async function removeActiveWork(
    input: RemoveActiveWorkInput,
): Promise<ActiveWorkRemoveResult> {
    const repository = await inspectRepository(input.projectRoot);
    const entryId = safeText(input.entryId, 'entryId', 200);

    return withRegistryLock(async () => {
        const state = await readRegistry();
        const match = state.entries.find(
            (entry) =>
                entry.id === entryId && entry.repositoryId === repository.id,
        );
        if (!match) {
            return {
                repository,
                removed: false,
                entryId,
                entries: entriesForRepository(state, repository.id),
            };
        }
        const nextState: ActiveWorkRegistryState = {
            version: 1,
            entries: state.entries.filter((entry) => entry.id !== entryId),
        };
        await writeRegistry(nextState);
        return {
            repository,
            removed: true,
            entryId,
            entries: entriesForRepository(nextState, repository.id),
        };
    });
}
