import crypto from 'node:crypto';
import { execFile } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import { validatePath } from '../tools/filesystem.js';
import {
    getOperationalMemorySummary,
    OperationalMemorySummary,
    recordOperationalLesson,
    recordOperationalToolFailure,
} from './operational-memory.js';
import {
    resolveWorkflowMemoryPath,
    resolveWorkflowStatePath,
    resolveWorkflowStateRoot,
} from './workflow-storage.js';
import {
    resolveProjectIdentity,
    type ProjectIdentity,
    type RunId,
    type TaskId,
} from './scope-identity.js';
import {
    tryResolveProjectProfile,
    type ResolvedProjectProfile,
} from './project-profile.js';

export {
    recordOperationalLesson,
    recordOperationalToolFailure,
    resolveWorkflowMemoryPath,
    resolveWorkflowStatePath,
    resolveWorkflowStateRoot,
};

export type WorkflowStageStatus =
    | 'pending'
    | 'completed'
    | 'blocked'
    | 'waiting_external'
    | 'skipped';
export type WorkflowWorkMode = 'read_only' | 'side_effecting';
export type WorkflowEvidenceScope = 'workflow' | 'git_head';
export type WorkflowEvidenceKind =
    | 'agent_attestation'
    | 'provider_reference'
    | 'user_authorization';

export interface WorkflowStageDefinition {
    id: string;
    label: string;
    description?: string;
    required: boolean;
    authorizationRequired?: boolean;
    dependsOn?: string[];
    workMode?: WorkflowWorkMode;
    evidenceScope?: WorkflowEvidenceScope;
}

export interface ProjectWorkflowProfile {
    version: 1;
    id: string;
    name: string;
    definitionOfDone?: string;
    constraints?: string[];
    metadata?: Record<string, string>;
    stages: WorkflowStageDefinition[];
}

export interface WorkflowGitSnapshot {
    branch: string;
    head: string;
    dirty: boolean;
    changedCount: number;
    remotes: Record<string, string>;
    refs: Record<string, string>;
    checkedAt: string;
}

interface WorkflowEvidence {
    kind: WorkflowEvidenceKind;
    summary: string;
    reference?: string;
    recordedAt: string;
    trust: 'attested' | 'trusted_host';
    gitHead?: string;
}

interface WorkflowStageState {
    status: WorkflowStageStatus;
    updatedAt: string;
    evidence?: WorkflowEvidence;
    reason?: string;
}

interface WorkflowStateBase {
    workflowId: string;
    projectRoot: string;
    goal: string;
    profilePath: string;
    profileFingerprint: string;
    profile: ProjectWorkflowProfile;
    startedAt: string;
    updatedAt: string;
    completedAt?: string;
    stages: Record<string, WorkflowStageState>;
    gitBaseline: WorkflowGitSnapshot;
    lastGitCheck?: WorkflowGitSnapshot;
}

interface WorkflowStateV1 extends WorkflowStateBase {
    version: 1;
}

interface WorkflowStateV2 extends WorkflowStateBase {
    version: 2;
    taskId: TaskId;
    runId: RunId;
}

type WorkflowState = WorkflowStateV1 | WorkflowStateV2;

export interface WorkflowProgress {
    totalStages: number;
    completedStages: number;
    requiredStages: number;
    requiredCompletedStages: number;
    percentComplete: number;
    percentRemaining: number;
}

export interface WorkflowStageView extends WorkflowStageDefinition, WorkflowStageState {
    evidenceStale: boolean;
}

export interface WorkflowStatus {
    workflowId: string;
    taskId: TaskId;
    runId?: RunId;
    projectRoot: string;
    projectIdentity: ProjectIdentity;
    statePath: string;
    goal: string;
    profile: ProjectWorkflowProfile;
    projectProfile?: ResolvedProjectProfile;
    profilePath: string;
    profileFingerprint: string;
    profileDrifted: boolean;
    startedAt: string;
    updatedAt: string;
    completedAt?: string;
    completed: boolean;
    stages: WorkflowStageView[];
    progress: WorkflowProgress;
    nextStage: WorkflowStageView | null;
    readyStages: WorkflowStageView[];
    opportunisticStages: WorkflowStageView[];
    waitingStages: WorkflowStageView[];
    recommendedStage: WorkflowStageView | null;
    operationalMemory: OperationalMemorySummary;
    git: WorkflowGitSnapshot;
    gitBaseline: WorkflowGitSnapshot;
}

export interface StartWorkflowInput {
    projectRoot: string;
    goal: string;
    restart?: boolean;
}

export interface ProjectRootInput {
    projectRoot: string;
}

export interface RecordWorkflowStageInput extends ProjectRootInput {
    stageId: string;
    status: Exclude<WorkflowStageStatus, 'pending'>;
    evidence?: {
        kind: WorkflowEvidenceKind;
        summary: string;
        reference?: string;
    };
    reason?: string;
}

export interface RecordWorkflowStageOptions {
    trustedUserAuthorization?: boolean;
}

const PROFILE_RELATIVE_PATH = path.join('.desktop-commander', 'project-workflow.json');
const MAX_TEXT = 2000;
const writeChains = new Map<string, Promise<void>>();

function now(): string {
    return new Date().toISOString();
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
        text = text.slice(0, max) + 'ÔÇŽ';
    }
    return text;
}

function parseStage(value: unknown, index: number): WorkflowStageDefinition {
    if (!value || typeof value !== 'object') {
        throw new Error('stages[' + index + '] must be an object');
    }
    const raw = value as Record<string, unknown>;
    const id = safeText(raw.id, 'stages[' + index + '].id', 120);
    if (!/^[a-z0-9][a-z0-9._-]*$/i.test(id)) {
        throw new Error('stages[' + index + '].id is invalid');
    }
    if (typeof raw.required !== 'boolean') {
        throw new Error('stages[' + index + '].required must be a boolean');
    }
    if (
        raw.authorizationRequired !== undefined &&
        typeof raw.authorizationRequired !== 'boolean'
    ) {
        throw new Error(
            'stages[' + index + '].authorizationRequired must be a boolean',
        );
    }
    let dependsOn: string[] | undefined;
    if (raw.dependsOn !== undefined) {
        if (!Array.isArray(raw.dependsOn)) {
            throw new Error('stages[' + index + '].dependsOn must be an array');
        }
        dependsOn = raw.dependsOn.map((item, depIndex) =>
            safeText(item, 'stages[' + index + '].dependsOn[' + depIndex + ']', 120),
        );
        if (new Set(dependsOn).size !== dependsOn.length) {
            throw new Error('stages[' + index + '].dependsOn contains duplicates');
        }
    }
    if (
        raw.workMode !== undefined &&
        raw.workMode !== 'read_only' &&
        raw.workMode !== 'side_effecting'
    ) {
        throw new Error('stages[' + index + '].workMode is invalid');
    }
    if (
        raw.evidenceScope !== undefined &&
        raw.evidenceScope !== 'workflow' &&
        raw.evidenceScope !== 'git_head'
    ) {
        throw new Error('stages[' + index + '].evidenceScope is invalid');
    }
    return {
        id,
        label: safeText(raw.label, 'stages[' + index + '].label', 200),
        ...(raw.description !== undefined
            ? { description: safeText(raw.description, 'stage description', 1000) }
            : {}),
        required: raw.required,
        ...(raw.authorizationRequired === true
            ? { authorizationRequired: true }
            : {}),
        ...(dependsOn !== undefined ? { dependsOn } : {}),
        ...(raw.workMode !== undefined
            ? { workMode: raw.workMode as WorkflowWorkMode }
            : {}),
        ...(raw.evidenceScope !== undefined
            ? { evidenceScope: raw.evidenceScope as WorkflowEvidenceScope }
            : {}),
    };
}

export function parseProjectWorkflowProfile(value: unknown): ProjectWorkflowProfile {
    if (!value || typeof value !== 'object') {
        throw new Error('project workflow profile root must be an object');
    }
    const raw = value as Record<string, unknown>;
    if (raw.version !== 1) {
        throw new Error('project workflow profile version must be 1');
    }
    if (!Array.isArray(raw.stages) || raw.stages.length === 0 || raw.stages.length > 100) {
        throw new Error('project workflow profile stages must contain 1-100 items');
    }
    const stages = raw.stages.map(parseStage);
    const ids = new Set<string>();
    for (let index = 0; index < stages.length; index += 1) {
        const stage = stages[index];
        if (ids.has(stage.id)) {
            throw new Error('duplicate project workflow stage id: ' + stage.id);
        }
        if (stage.dependsOn !== undefined) {
            for (const dependency of stage.dependsOn) {
                if (!ids.has(dependency)) {
                    throw new Error(
                        'Stage ' + stage.id +
                            ' dependsOn dependency ' + dependency +
                            ' which must reference an earlier stage',
                    );
                }
            }
        }
        ids.add(stage.id);
    }

    let constraints: string[] | undefined;
    if (raw.constraints !== undefined) {
        if (!Array.isArray(raw.constraints)) {
            throw new Error('constraints must be an array');
        }
        constraints = raw.constraints.map((item, index) =>
            safeText(item, 'constraints[' + index + ']', 1000),
        );
    }

    let metadata: Record<string, string> | undefined;
    if (raw.metadata !== undefined) {
        if (!raw.metadata || typeof raw.metadata !== 'object' || Array.isArray(raw.metadata)) {
            throw new Error('metadata must be an object');
        }
        metadata = {};
        for (const [key, item] of Object.entries(raw.metadata as Record<string, unknown>)) {
            metadata[safeText(key, 'metadata key', 120)] =
                safeText(item, 'metadata.' + key, 1000);
        }
    }

    return {
        version: 1,
        id: safeText(raw.id, 'profile.id', 160),
        name: safeText(raw.name, 'profile.name', 300),
        ...(raw.definitionOfDone !== undefined
            ? { definitionOfDone: safeText(raw.definitionOfDone, 'definitionOfDone', 2000) }
            : {}),
        ...(constraints ? { constraints } : {}),
        ...(metadata ? { metadata } : {}),
        stages,
    };
}

export function resolveProjectWorkflowProfilePath(projectRoot: string): string {
    return path.join(path.resolve(projectRoot), PROFILE_RELATIVE_PATH);
}

function isWithin(candidate: string, root: string): boolean {
    const relative = path.relative(path.resolve(root), path.resolve(candidate));
    return (
        relative === '' ||
        (relative !== '..' &&
            !relative.startsWith('..' + path.sep) &&
            !path.isAbsolute(relative))
    );
}

export function isProjectWorkflowControlPlanePath(resource: string): boolean {
    if (typeof resource !== 'string' || !resource.trim()) {
        return false;
    }
    const resolved = path.resolve(resource);
    if (isWithin(resolved, resolveWorkflowStateRoot())) {
        return true;
    }
    return (
        path.basename(resolved).toLowerCase() === 'project-workflow.json' &&
        path.basename(path.dirname(resolved)).toLowerCase() === '.desktop-commander'
    );
}

async function canonicalizeWorkflowResource(resource: string): Promise<string> {
    const absolute = path.resolve(resource);
    try {
        return await fs.realpath(absolute);
    } catch {
        // For a not-yet-created target, resolve the deepest existing ancestor.
        // This closes symlink/junction aliases without requiring the final file to exist.
    }

    let current = absolute;
    const remaining: string[] = [];
    while (true) {
        const parent = path.dirname(current);
        if (parent === current) {
            break;
        }
        remaining.unshift(path.basename(current));
        current = parent;
        try {
            const realAncestor = await fs.realpath(current);
            return path.join(realAncestor, ...remaining);
        } catch {
            // Continue walking toward the filesystem root.
        }
    }
    return absolute;
}

export async function isProjectWorkflowControlPlaneResource(
    resource: string,
): Promise<boolean> {
    if (isProjectWorkflowControlPlanePath(resource)) {
        return true;
    }
    const canonical = await canonicalizeWorkflowResource(resource);
    return isProjectWorkflowControlPlanePath(canonical);
}

function fingerprint(text: string): string {
    return crypto.createHash('sha256').update(text, 'utf8').digest('hex');
}

async function loadProfile(projectRoot: string): Promise<{
    profile: ProjectWorkflowProfile;
    profilePath: string;
    profileFingerprint: string;
}> {
    const requested = resolveProjectWorkflowProfilePath(projectRoot);
    const profilePath = await validatePath(requested);
    let text: string;
    try {
        text = await fs.readFile(profilePath, 'utf8');
    } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
            throw new Error('Project workflow profile not found at ' + requested);
        }
        throw error;
    }

    let json: unknown;
    try {
        json = JSON.parse(text);
    } catch (error) {
        throw new Error(
            'Invalid project workflow profile JSON: ' +
                (error instanceof Error ? error.message : String(error)),
        );
    }
    return {
        profile: parseProjectWorkflowProfile(json),
        profilePath,
        profileFingerprint: fingerprint(text),
    };
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
                    reject(new Error('Git inspection failed (' + (args[0] ?? 'command') + ')' + detail));
                    return;
                }
                resolve((stdout ?? '').trim());
            },
        );
    });
}

async function gitOptional(projectRoot: string, args: string[]): Promise<string | undefined> {
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

function sanitizeRemote(value: string): string {
    const safe = safeText(value, 'remote url', 1000);
    try {
        const parsed = new URL(safe);
        parsed.username = '';
        parsed.password = '';
        parsed.search = '';
        parsed.hash = '';
        return parsed.toString();
    } catch {
        return safe.replace(/^([^@\s]+)@([^:\s]+):/, '<user>@$2:');
    }
}

async function inspectGit(projectRoot: string): Promise<WorkflowGitSnapshot> {
    const [head, branch, status, remoteList] = await Promise.all([
        git(projectRoot, ['rev-parse', 'HEAD']),
        gitOptional(projectRoot, ['symbolic-ref', '--short', 'HEAD']),
        git(projectRoot, ['status', '--porcelain=v1']),
        gitOptional(projectRoot, ['remote']),
    ]);

    const remotes: Record<string, string> = {};
    for (const remote of (remoteList ?? '').split(/\r?\n/).map((v) => v.trim()).filter(Boolean)) {
        const url = await gitOptional(projectRoot, ['remote', 'get-url', remote]);
        if (url) {
            remotes[safeText(remote, 'remote name', 120)] = sanitizeRemote(url);
        }
    }

    const refs: Record<string, string> = {};
    const knownRefs: Array<[string, string]> = [
        ['main', 'refs/heads/main'],
        ['prototype/free-pro-team', 'refs/heads/prototype/free-pro-team'],
        ['origin/main', 'refs/remotes/origin/main'],
        ['origin/prototype/free-pro-team', 'refs/remotes/origin/prototype/free-pro-team'],
        ['upstream/main', 'refs/remotes/upstream/main'],
    ];
    for (const [label, ref] of knownRefs) {
        const value = await gitOptional(projectRoot, ['show-ref', '--verify', '--hash', ref]);
        if (value) {
            refs[label] = value;
        }
    }

    const changedCount = status ? status.split(/\r?\n/).filter(Boolean).length : 0;
    return {
        branch: branch ?? 'DETACHED',
        head,
        dirty: changedCount > 0,
        changedCount,
        remotes,
        refs,
        checkedAt: now(),
    };
}

function taskIdForState(state: WorkflowState): TaskId {
    return state.version === 2 ? state.taskId : state.workflowId;
}

function runIdForState(state: WorkflowState): RunId | undefined {
    return state.version === 2 ? state.runId : undefined;
}

function parseState(value: unknown): WorkflowState {
    if (!value || typeof value !== 'object') {
        throw new Error('project workflow state root must be an object');
    }
    const raw = value as Record<string, unknown>;
    if ((raw.version !== 1 && raw.version !== 2) || !raw.profile || !raw.stages || !raw.gitBaseline) {
        throw new Error('project workflow state is invalid or incomplete');
    }
    if (typeof raw.workflowId !== 'string' || !raw.workflowId.trim()) {
        throw new Error('project workflow state workflowId is invalid');
    }
    if (raw.version === 1) {
        if (raw.taskId !== undefined || raw.runId !== undefined) {
            throw new Error('project workflow state v1 must not contain taskId/runId');
        }
    } else {
        if (typeof raw.taskId !== 'string' || !raw.taskId.trim() ||
            typeof raw.runId !== 'string' || !raw.runId.trim()) {
            throw new Error('project workflow state v2 taskId/runId is invalid');
        }
        if (raw.taskId !== raw.workflowId) {
            throw new Error('project workflow state v2 workflowId/taskId mismatch');
        }
    }
    const profile = parseProjectWorkflowProfile(raw.profile);
    const stageStates = raw.stages as Record<string, WorkflowStageState>;
    for (const stage of profile.stages) {
        const state = stageStates[stage.id];
        if (!state || !['pending', 'completed', 'blocked', 'waiting_external', 'skipped'].includes(state.status)) {
            throw new Error('project workflow stage state is invalid: ' + stage.id);
        }
    }
    return raw as unknown as WorkflowState;
}

async function loadState(projectRoot: string): Promise<WorkflowState> {
    const statePath = resolveWorkflowStatePath(projectRoot);
    let text: string;
    try {
        text = await fs.readFile(statePath, 'utf8');
    } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
            throw new Error('No project workflow state exists. Start the workflow first.');
        }
        throw error;
    }
    try {
        return parseState(JSON.parse(text));
    } catch (error) {
        throw new Error(
            'Invalid project workflow state. Refusing to continue: ' +
                (error instanceof Error ? error.message : String(error)),
        );
    }
}

async function persistState(state: WorkflowState): Promise<void> {
    const statePath = resolveWorkflowStatePath(state.projectRoot);
    await fs.mkdir(path.dirname(statePath), { recursive: true });
    const tempPath = statePath + '.tmp-' + process.pid + '-' + Date.now();
    try {
        await fs.writeFile(tempPath, JSON.stringify(state, null, 2), 'utf8');
        try {
            await fs.rename(tempPath, statePath);
        } catch (error) {
            if ((error as NodeJS.ErrnoException).code !== 'EPERM') {
                throw error;
            }
            await fs.rm(statePath, { force: true });
            await fs.rename(tempPath, statePath);
        }
    } finally {
        await fs.rm(tempPath, { force: true }).catch(() => undefined);
    }
}

async function mutateState(
    projectRoot: string,
    update: (state: WorkflowState) => Promise<WorkflowState> | WorkflowState,
): Promise<WorkflowState> {
    const statePath = resolveWorkflowStatePath(projectRoot);
    const prior = writeChains.get(statePath) ?? Promise.resolve();
    let result: WorkflowState | undefined;
    const operation = prior.then(async () => {
        result = await update(await loadState(projectRoot));
        await persistState(result);
    });
    writeChains.set(statePath, operation.then(() => undefined, () => undefined));
    await operation;
    if (!result) {
        throw new Error('Project workflow mutation did not produce a result');
    }
    return result;
}

function progress(stages: WorkflowStageView[]): WorkflowProgress {
    const totalStages = stages.length;
    const requiredStages = stages.filter((stage) => stage.required).length;
    let completedStages = 0;
    let requiredCompletedStages = 0;
    for (const stage of stages) {
        const satisfied =
            stage.status === 'skipped' ||
            (stage.status === 'completed' && !stage.evidenceStale);
        if (satisfied) {
            completedStages += 1;
        }
        if (stage.required && stage.status === 'completed' && !stage.evidenceStale) {
            requiredCompletedStages += 1;
        }
    }
    const percentComplete = Math.round((completedStages / totalStages) * 100);
    return {
        totalStages,
        completedStages,
        requiredStages,
        requiredCompletedStages,
        percentComplete,
        percentRemaining: Math.max(0, 100 - percentComplete),
    };
}

function dependenciesForStage(
    profile: ProjectWorkflowProfile,
    index: number,
): string[] {
    const stage = profile.stages[index];
    if (stage.dependsOn !== undefined) {
        return stage.dependsOn;
    }
    return index === 0 ? [] : [profile.stages[index - 1].id];
}

function isSatisfied(stage: WorkflowStageView): boolean {
    return (
        stage.status === 'skipped' ||
        (stage.status === 'completed' && !stage.evidenceStale)
    );
}
function stateStageSatisfied(
    definition: WorkflowStageDefinition,
    state: WorkflowStageState,
    gitHead: string,
): boolean {
    if (state.status === 'skipped') {
        return true;
    }
    if (state.status !== 'completed') {
        return false;
    }
    return definition.evidenceScope !== 'git_head' || state.evidence?.gitHead === gitHead;
}

async function profileDrifted(state: WorkflowState): Promise<boolean> {
    try {
        return fingerprint(await fs.readFile(state.profilePath, 'utf8')) !==
            state.profileFingerprint;
    } catch {
        return true;
    }
}

async function toStatus(
    state: WorkflowState,
    gitSnapshot?: WorkflowGitSnapshot,
): Promise<WorkflowStatus> {
    const git = gitSnapshot ?? (await inspectGit(state.projectRoot));
    const projectProfile = await tryResolveProjectProfile(state.projectRoot);
    const projectIdentity = projectProfile?.identity ??
        (await resolveProjectIdentity(state.projectRoot));
    const stages: WorkflowStageView[] = state.profile.stages.map((definition) => {
        const stageState = state.stages[definition.id];
        const evidenceStale =
            definition.evidenceScope === 'git_head' &&
            stageState.status === 'completed' &&
            stageState.evidence?.gitHead !== git.head;
        return {
            ...definition,
            ...stageState,
            evidenceStale,
        };
    });
    const byId = new Map(stages.map((stage) => [stage.id, stage]));
    const readyStages = stages.filter((stage, index) => {
        if (stage.status !== 'pending' && !stage.evidenceStale) {
            return false;
        }
        return dependenciesForStage(state.profile, index).every((dependency) => {
            const dependencyStage = byId.get(dependency);
            return dependencyStage ? isSatisfied(dependencyStage) : false;
        });
    });
    const opportunisticStages = readyStages.filter(
        (stage) => stage.workMode === 'read_only',
    );
    const waitingStages = stages.filter(
        (stage) => stage.status === 'waiting_external',
    );
    const nextStage =
        stages.find(
            (stage) =>
                stage.evidenceStale ||
                stage.status === 'pending' ||
                stage.status === 'blocked' ||
                stage.status === 'waiting_external',
        ) ?? null;
    const recommendedStage =
        nextStage?.status === 'blocked'
            ? nextStage
            : nextStage?.status === 'waiting_external'
                ? (opportunisticStages[0] ?? nextStage)
                : (readyStages[0] ?? nextStage);
    const operationalMemory = await getOperationalMemorySummary(
        state.projectRoot,
        state.workflowId,
        recommendedStage?.id ?? nextStage?.id,
    );
    return {
        workflowId: state.workflowId,
        taskId: taskIdForState(state),
        ...(runIdForState(state) ? { runId: runIdForState(state) } : {}),
        projectRoot: state.projectRoot,
        projectIdentity,
        statePath: resolveWorkflowStatePath(state.projectRoot),
        goal: state.goal,
        profile: state.profile,
        ...(projectProfile ? { projectProfile } : {}),
        profilePath: state.profilePath,
        profileFingerprint: state.profileFingerprint,
        profileDrifted: await profileDrifted(state),
        startedAt: state.startedAt,
        updatedAt: state.updatedAt,
        ...(state.completedAt ? { completedAt: state.completedAt } : {}),
        completed: !!state.completedAt,
        stages,
        progress: progress(stages),
        nextStage,
        readyStages,
        opportunisticStages,
        waitingStages,
        recommendedStage,
        operationalMemory,
        git,
        gitBaseline: state.gitBaseline,
    };
}

export async function startProjectWorkflow(input: StartWorkflowInput): Promise<WorkflowStatus> {
    const projectRoot = await resolveGitRoot(input.projectRoot);
    const goal = safeText(input.goal, 'goal', 2000);
    try {
        const existing = await loadState(projectRoot);
        if (!existing.completedAt && input.restart !== true) {
            throw new Error(
                'An active project workflow already exists. Use resume, or set restart=true explicitly.',
            );
        }
    } catch (error) {
        if (
            error instanceof Error &&
            !error.message.startsWith('No project workflow state exists')
        ) {
            throw error;
        }
    }

    const loaded = await loadProfile(projectRoot);
    const startedAt = now();
    const gitBaseline = await inspectGit(projectRoot);
    const stages = Object.fromEntries(
        loaded.profile.stages.map((stage) => [
            stage.id,
            { status: 'pending' as const, updatedAt: startedAt },
        ]),
    );
    const taskId = crypto.randomUUID();
    const runId = crypto.randomUUID();
    const state: WorkflowState = {
        version: 2,
        workflowId: taskId,
        taskId,
        runId,
        projectRoot,
        goal,
        profilePath: loaded.profilePath,
        profileFingerprint: loaded.profileFingerprint,
        profile: loaded.profile,
        startedAt,
        updatedAt: startedAt,
        stages,
        gitBaseline,
        lastGitCheck: gitBaseline,
    };
    await persistState(state);
    return toStatus(state, gitBaseline);
}

export async function getProjectWorkflowStatus(input: ProjectRootInput): Promise<WorkflowStatus> {
    const projectRoot = await resolveGitRoot(input.projectRoot);
    return toStatus(await loadState(projectRoot));
}

export async function resumeProjectWorkflow(input: ProjectRootInput): Promise<WorkflowStatus> {
    const projectRoot = await resolveGitRoot(input.projectRoot);
    const gitSnapshot = await inspectGit(projectRoot);
    const state = await mutateState(projectRoot, (current) => {
        const taskId = taskIdForState(current);
        return {
            ...current,
            version: 2,
            workflowId: taskId,
            taskId,
            runId: crypto.randomUUID(),
            updatedAt: now(),
            lastGitCheck: gitSnapshot,
        };
    });
    return toStatus(state, gitSnapshot);
}

function evidenceFromInput(
    value: RecordWorkflowStageInput['evidence'],
    gitHead?: string,
): WorkflowEvidence {
    if (!value) {
        throw new Error('Completed stages require evidence');
    }
    if (!['agent_attestation', 'provider_reference', 'user_authorization'].includes(value.kind)) {
        throw new Error('Invalid project workflow evidence kind');
    }
    return {
        kind: value.kind,
        summary: safeText(value.summary, 'evidence.summary'),
        ...(value.reference !== undefined
            ? { reference: safeText(value.reference, 'evidence.reference') }
            : {}),
        recordedAt: now(),
        trust: 'attested',
        ...(gitHead ? { gitHead } : {}),
    };
}

export async function recordProjectWorkflowStage(
    input: RecordWorkflowStageInput,
    options: RecordWorkflowStageOptions = {},
): Promise<WorkflowStatus> {
    const projectRoot = await resolveGitRoot(input.projectRoot);
    const gitSnapshot = await inspectGit(projectRoot);
    const state = await mutateState(projectRoot, (current) => {
        if (current.completedAt) {
            throw new Error('Project workflow is already complete');
        }
        const stage = current.profile.stages.find((item) => item.id === input.stageId);
        if (!stage) {
            throw new Error('Unknown project workflow stage: ' + input.stageId);
        }
        if (input.status === 'skipped' && stage.required) {
            throw new Error('Required stage ' + stage.id + ' cannot be skipped');
        }

        let completedEvidence: WorkflowEvidence | undefined;
        if (input.status === 'completed') {
            completedEvidence = evidenceFromInput(
                input.evidence,
                stage.evidenceScope === 'git_head' ? gitSnapshot.head : undefined,
            );
            if (
                stage.authorizationRequired &&
                (completedEvidence.kind !== 'user_authorization' || !options.trustedUserAuthorization)
            ) {
                throw new Error(
                    'Stage ' + stage.id +
                        ' requires trusted user authorization; an agent cannot self-attest it',
                );
            }
        }

        const stageIndex = current.profile.stages.findIndex((item) => item.id === stage.id);
        const unsatisfiedDependencies = dependenciesForStage(current.profile, stageIndex).filter((dependencyId) => {
            const dependencyIndex = current.profile.stages.findIndex((item) => item.id === dependencyId);
            const dependency = current.profile.stages[dependencyIndex];
            return !dependency || !stateStageSatisfied(dependency, current.stages[dependencyId], gitSnapshot.head);
        });
        if (unsatisfiedDependencies.length) {
            throw new Error(
                'Stage ' + stage.id + ' cannot advance before dependencies are satisfied: ' +
                    unsatisfiedDependencies.join(', '),
            );
        }

        let stageState: WorkflowStageState;
        const updatedAt = now();
        if (input.status === 'completed') {
            const evidence = completedEvidence!;
            stageState = {
                status: 'completed',
                updatedAt,
                evidence: {
                    ...evidence,
                    trust:
                        evidence.kind === 'user_authorization' && options.trustedUserAuthorization
                            ? 'trusted_host'
                            : 'attested',
                },
            };
        } else {
            stageState = {
                status: input.status,
                updatedAt,
                reason: safeText(input.reason, input.status + ' stage reason'),
            };
        }
        return {
            ...current,
            updatedAt,
            stages: { ...current.stages, [stage.id]: stageState },
        };
    });
    return toStatus(state, gitSnapshot);
}

export async function finishProjectWorkflow(input: ProjectRootInput): Promise<WorkflowStatus> {
    const projectRoot = await resolveGitRoot(input.projectRoot);
    const gitSnapshot = await inspectGit(projectRoot);
    const state = await mutateState(projectRoot, async (current) => {
        if (current.completedAt) {
            return current;
        }
        if (await profileDrifted(current)) {
            throw new Error(
                'Project workflow profile changed after start (profile drift/fingerprint mismatch).',
            );
        }
        const staleEvidence = current.profile.stages
            .filter(
                (stage) =>
                    stage.evidenceScope === 'git_head' &&
                    current.stages[stage.id].status === 'completed' &&
                    current.stages[stage.id].evidence?.gitHead !== gitSnapshot.head,
            )
            .map((stage) => stage.id);
        if (staleEvidence.length) {
            throw new Error(
                'Cannot finish: git-head scoped evidence is stale: ' +
                    staleEvidence.join(', '),
            );
        }
        const missingRequired = current.profile.stages
            .filter((stage) => stage.required && current.stages[stage.id].status !== 'completed')
            .map((stage) => stage.id);
        if (missingRequired.length) {
            throw new Error(
                'Cannot finish: required stages are incomplete: ' + missingRequired.join(', '),
            );
        }
        const unresolved = current.profile.stages
            .filter((stage) => {
                const status = current.stages[stage.id].status;
                return (
                    status === 'pending' ||
                    status === 'blocked' ||
                    status === 'waiting_external'
                );
            })
            .map((stage) => stage.id);
        if (unresolved.length) {
            throw new Error(
                'Cannot finish: lifecycle stages still need completion or explicit skip: ' +
                    unresolved.join(', '),
            );
        }
        const completedAt = now();
        return { ...current, updatedAt: completedAt, completedAt };
    });
    return toStatus(state, gitSnapshot);
}
