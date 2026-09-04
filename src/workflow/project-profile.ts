import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { validatePath } from '../tools/filesystem.js';
import {
    resolveProjectIdentity,
    type ProjectIdentity,
} from './scope-identity.js';

const PROFILE_RELATIVE_PATH = path.join('.desktop-commander', 'project-profile.json');
const WORKFLOW_PROFILE_REFERENCE = '.desktop-commander/project-workflow.json';
const MAX_TEXT = 2000;
const MAX_ITEMS = 100;

export interface ProjectDocumentReference {
    label: string;
    uri: string;
}

export interface ProjectRepositoryGuidance {
    authoritativeRepository: string;
    authoritativeBranch: string;
    upstreamRepository?: string;
    upstreamBranch?: string;
}

export interface ProjectGraphifyGuidance {
    wrapper: string;
    mode: 'local_code_only';
}

export interface ProjectProfile {
    version: 1;
    name: string;
    instructions: string[];
    definitionOfDone: string;
    requiredPreRead: ProjectDocumentReference[];
    repository: ProjectRepositoryGuidance;
    workflowProfile: string;
    verificationRequirements: string[];
    deploymentRequirements: string[];
    graphify: ProjectGraphifyGuidance;
    documentation: ProjectDocumentReference[];
}

export interface ResolvedProjectProfile {
    identity: ProjectIdentity;
    profile: ProjectProfile;
    profilePath: string;
    profileFingerprint: string;
    workflowProfilePath: string;
    repositoryMatches: {
        authoritativeRepository: boolean;
        authoritativeBranch: boolean;
    };
}

const ROOT_KEYS = new Set([
    'version',
    'name',
    'instructions',
    'definitionOfDone',
    'requiredPreRead',
    'repository',
    'workflowProfile',
    'verificationRequirements',
    'deploymentRequirements',
    'graphify',
    'documentation',
]);

function requireRecord(value: unknown, label: string): Record<string, unknown> {
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
        throw new Error(label + ' must be an object');
    }
    return value as Record<string, unknown>;
}
function rejectUnknownKeys(
    value: Record<string, unknown>,
    allowed: Set<string>,
    label: string,
): void {
    for (const key of Object.keys(value)) {
        if (!allowed.has(key)) {
            throw new Error('unknown ' + label + ' field: ' + key);
        }
    }
}

function safeText(value: unknown, label: string, max = MAX_TEXT): string {
    if (typeof value !== 'string' || !value.trim()) {
        throw new Error(label + ' must be a non-empty string');
    }
    const text = value.trim();
    if (text.length > max) {
        throw new Error(label + ' is too long; maximum is ' + max + ' characters');
    }
    return text;
}

function stringArray(value: unknown, label: string, max = MAX_ITEMS): string[] {
    if (!Array.isArray(value) || value.length === 0 || value.length > max) {
        throw new Error(label + ' must contain 1-' + max + ' items');
    }
    const items = value.map((item, index) => safeText(item, label + '[' + index + ']'));
    if (new Set(items).size !== items.length) {
        throw new Error(label + ' must not contain duplicates');
    }
    return items;
}

function references(value: unknown, label: string): ProjectDocumentReference[] {
    if (!Array.isArray(value) || value.length === 0 || value.length > 50) {
        throw new Error(label + ' must contain 1-50 items');
    }
    return value.map((item, index) => {
        const raw = requireRecord(item, label + '[' + index + ']');
        rejectUnknownKeys(raw, new Set(['label', 'uri']), label + '[' + index + ']');
        return {
            label: safeText(raw.label, label + '[' + index + '].label', 300),
            uri: safeText(raw.uri, label + '[' + index + '].uri', 4000),
        };
    });
}

function repositoryIdentifier(value: unknown, label: string): string {
    const text = safeText(value, label, 500).replace(/\.git$/i, '');
    if (!/^[A-Za-z0-9.-]+\/[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+(?:\/[A-Za-z0-9._-]+)*$/.test(text)) {
        throw new Error(label + ' must use host/owner/repository form');
    }
    return text;
}
function relativeProjectPath(value: unknown, label: string): string {
    const text = safeText(value, label, 1000).replace(/\\/g, '/');
    if (
        text.startsWith('/') ||
        /^[A-Za-z]:\//.test(text) ||
        path.isAbsolute(text) ||
        text.split('/').includes('..')
    ) {
        throw new Error(label + ' must be a relative path within the project root');
    }
    const normalized = path.posix.normalize(text);
    if (!normalized || normalized === '.' || normalized.startsWith('../')) {
        throw new Error(label + ' must be a relative path within the project root');
    }
    return normalized;
}

function workflowProfileReference(value: unknown): string {
    const reference = relativeProjectPath(value, 'workflowProfile');
    if (reference !== WORKFLOW_PROFILE_REFERENCE) {
        throw new Error('workflowProfile must reference the protected .desktop-commander/project-workflow.json control-plane profile');
    }
    return reference;
}
function parseRepository(value: unknown): ProjectRepositoryGuidance {
    const raw = requireRecord(value, 'repository');
    rejectUnknownKeys(
        raw,
        new Set(['authoritativeRepository', 'authoritativeBranch', 'upstreamRepository', 'upstreamBranch']),
        'project profile repository',
    );
    const upstreamRepository = raw.upstreamRepository === undefined
        ? undefined
        : repositoryIdentifier(raw.upstreamRepository, 'repository.upstreamRepository');
    const upstreamBranch = raw.upstreamBranch === undefined
        ? undefined
        : safeText(raw.upstreamBranch, 'repository.upstreamBranch', 300);
    if ((upstreamRepository === undefined) !== (upstreamBranch === undefined)) {
        throw new Error('repository upstreamRepository and upstreamBranch must be provided together');
    }
    return {
        authoritativeRepository: repositoryIdentifier(
            raw.authoritativeRepository,
            'repository.authoritativeRepository',
        ),
        authoritativeBranch: safeText(
            raw.authoritativeBranch,
            'repository.authoritativeBranch',
            300,
        ),
        ...(upstreamRepository ? { upstreamRepository, upstreamBranch: upstreamBranch! } : {}),
    };
}

function parseGraphify(value: unknown): ProjectGraphifyGuidance {
    const raw = requireRecord(value, 'graphify');
    rejectUnknownKeys(raw, new Set(['wrapper', 'mode']), 'project profile graphify');
    if (raw.mode !== 'local_code_only') {
        throw new Error('graphify.mode must be local_code_only');
    }
    return {
        wrapper: relativeProjectPath(raw.wrapper, 'graphify.wrapper'),
        mode: 'local_code_only',
    };
}
export function parseProjectProfile(value: unknown): ProjectProfile {
    const raw = requireRecord(value, 'project profile root');
    rejectUnknownKeys(raw, ROOT_KEYS, 'project profile');
    if (raw.version !== 1) {
        throw new Error('project profile version must be 1');
    }
    return {
        version: 1,
        name: safeText(raw.name, 'project profile name', 300),
        instructions: stringArray(raw.instructions, 'instructions'),
        definitionOfDone: safeText(raw.definitionOfDone, 'definitionOfDone'),
        requiredPreRead: references(raw.requiredPreRead, 'requiredPreRead'),
        repository: parseRepository(raw.repository),
        workflowProfile: workflowProfileReference(raw.workflowProfile),
        verificationRequirements: stringArray(
            raw.verificationRequirements,
            'verificationRequirements',
        ),
        deploymentRequirements: stringArray(
            raw.deploymentRequirements,
            'deploymentRequirements',
        ),
        graphify: parseGraphify(raw.graphify),
        documentation: references(raw.documentation, 'documentation'),
    };
}
export function resolveProjectProfilePath(projectRoot: string): string {
    return path.join(path.resolve(projectRoot), PROFILE_RELATIVE_PATH);
}

function isWithin(candidate: string, root: string): boolean {
    const relative = path.relative(path.resolve(root), path.resolve(candidate));
    return relative === '' || (
        relative !== '..' &&
        !relative.startsWith('..' + path.sep) &&
        !path.isAbsolute(relative)
    );
}

function normalizedRepository(value: string): string {
    return value.trim().replace(/\.git$/i, '').toLowerCase();
}

function fingerprint(text: string): string {
    return crypto.createHash('sha256').update(text, 'utf8').digest('hex');
}

async function readProfile(profilePath: string, requestedPath: string): Promise<string> {
    try {
        return await fs.readFile(profilePath, 'utf8');
    } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
            throw new Error('Project Profile not found at ' + requestedPath);
        }
        throw error;
    }
}
export async function resolveProjectProfile(projectRoot: string): Promise<ResolvedProjectProfile> {
    const identity = await resolveProjectIdentity(projectRoot);
    const root = identity.repository.worktreeRoot;
    const requestedProfilePath = resolveProjectProfilePath(root);
    const profilePath = await validatePath(requestedProfilePath);
    if (!isWithin(profilePath, root)) {
        throw new Error('Project Profile must remain within the project root');
    }
    const text = await readProfile(profilePath, requestedProfilePath);

    let json: unknown;
    try {
        json = JSON.parse(text);
    } catch (error) {
        throw new Error(
            'Invalid Project Profile JSON: ' +
                (error instanceof Error ? error.message : String(error)),
        );
    }
    const profile = parseProjectProfile(json);
    const requestedWorkflowPath = path.resolve(root, ...profile.workflowProfile.split('/'));
    if (!isWithin(requestedWorkflowPath, root)) {
        throw new Error('workflowProfile must remain within the project root');
    }
    const workflowProfilePath = await validatePath(requestedWorkflowPath);
    if (!isWithin(workflowProfilePath, root)) {
        throw new Error('workflowProfile must remain within the project root');
    }

    return {
        identity,
        profile,
        profilePath,
        profileFingerprint: fingerprint(text),
        workflowProfilePath,
        repositoryMatches: {
            authoritativeRepository:
                normalizedRepository(profile.repository.authoritativeRepository) ===
                normalizedRepository(identity.repository.display),
            authoritativeBranch:
                profile.repository.authoritativeBranch === identity.repository.branch,
        },
    };
}

export async function tryResolveProjectProfile(
    projectRoot: string,
): Promise<ResolvedProjectProfile | undefined> {
    try {
        return await resolveProjectProfile(projectRoot);
    } catch {
        // Project Profile is optional, untrusted guidance. Strict validation remains
        // available through resolveProjectProfile(), but workflow lifecycle calls must
        // not fail because optional guidance is missing, malformed, or unsafe.
        return undefined;
    }
}
