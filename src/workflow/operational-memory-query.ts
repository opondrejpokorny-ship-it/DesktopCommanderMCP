import type { Stats } from 'node:fs';
import { createRequire } from 'node:module';
import fs from 'node:fs/promises';
import path from 'node:path';

import {
  isOperationalLessonCode,
  OPERATIONAL_LESSON_TEMPLATES,
  type OperationalLessonCode,
} from './operational-memory-contract.js';
import { hasOperationalMemoryGlobalProjectLessonReadOnly, readOperationalMemoryGlobalGroupsReadOnly } from './operational-memory-global-index.js';
import { resolveWorkflowStateRoot } from './workflow-storage.js';

const INDEX_SCHEMA_VERSION = 5;
const JOURNAL_SUFFIX = '.memory.jsonl';
const INDEX_SUFFIX = '.memory.sqlite';
const runtimeRequire = createRequire(import.meta.url);

export type MemoryIndexHealth =
  | 'healthy' | 'stale' | 'missing' | 'corrupt' | 'orphaned' | 'unavailable';
export type MemoryBrowseScope = 'workflow' | 'project' | 'global';

export interface MemoryIndexHealthCounts {
  healthy: number;
  stale: number;
  missing: number;
  corrupt: number;
  orphaned: number;
}

export interface MemoryOverviewResponse {
  generatedAt: string;
  totalEvents: number;
  uniqueFingerprints: number;
  projectsWithMemory: number;
  countsByKind: { error: number; limit: number; lesson: number };
  journalBytes: number;
  indexBytes: number;
  lastActivityAt?: string;
  indexHealth: {
    overall: 'healthy' | 'degraded' | 'unavailable';
  } & MemoryIndexHealthCounts;
}

interface SqliteStatement {
  get(...params: unknown[]): Record<string, unknown> | undefined;
  all(...params: unknown[]): Array<Record<string, unknown>>;
}

interface SqliteDatabase {
  prepare(sql: string): SqliteStatement;
  close(): void;
}

interface SqliteModule {
  DatabaseSync?: new (
    location: string,
    options?: { readOnly?: boolean },
  ) => SqliteDatabase;
}

type DatabaseConstructor = NonNullable<SqliteModule['DatabaseSync']>;
let cachedDatabaseConstructor: DatabaseConstructor | null | undefined;
function databaseConstructor(): DatabaseConstructor | null {
  if (cachedDatabaseConstructor !== undefined) return cachedDatabaseConstructor;
  try {
    const sqlite = runtimeRequire(['node', 'sqlite'].join(':')) as SqliteModule;
    cachedDatabaseConstructor = sqlite.DatabaseSync ?? null;
  } catch {
    cachedDatabaseConstructor = null;
  }
  return cachedDatabaseConstructor;
}

interface MemoryFileSet {
  journalPath: string;
  indexPath: string;
  journalStat: Stats | null;
  indexStat: Stats | null;
}

interface ReadIndexState {
  authoritySizeBytes: number;
  authorityMtimeMs: number;
  authorityCtimeMs: number;
  recordCount: number;
  projectId?: string;
  repositoryId?: string;
}

function emptyHealthCounts(): MemoryIndexHealthCounts {
  return { healthy: 0, stale: 0, missing: 0, corrupt: 0, orphaned: 0 };
}
async function fileStat(target: string) {
  try {
    const stat = await fs.stat(target);
    return stat.isFile() ? stat : null;
  } catch {
    return null;
  }
}

async function discoverMemoryFiles(): Promise<MemoryFileSet[]> {
  const root = resolveWorkflowStateRoot();
  let names: string[];
  try {
    names = await fs.readdir(root);
  } catch {
    return [];
  }
  const basenames = new Set<string>();
  for (const name of names) {
    if (name.endsWith(JOURNAL_SUFFIX)) {
      basenames.add(name.slice(0, -JOURNAL_SUFFIX.length));
    } else if (name.endsWith(INDEX_SUFFIX)) {
      basenames.add(name.slice(0, -INDEX_SUFFIX.length));
    }
  }
  const result: MemoryFileSet[] = [];
  for (const basename of [...basenames].sort()) {
    const journalPath = path.join(root, basename + JOURNAL_SUFFIX);
    const indexPath = path.join(root, basename + INDEX_SUFFIX);
    result.push({
      journalPath, indexPath,
      journalStat: await fileStat(journalPath),
      indexStat: await fileStat(indexPath),
    });
  }
  return result;
}
function requireColumns(
  db: SqliteDatabase,
  table: string,
  required: readonly string[],
): void {
  const columns = new Set(
    db.prepare(`PRAGMA table_info(${table})`).all().map((row) => String(row.name)),
  );
  for (const column of required) {
    if (!columns.has(column)) throw new Error(`Incompatible ${table} schema`);
  }
}

function readValidatedIndexState(db: SqliteDatabase): ReadIndexState {
  requireColumns(db, 'events', [
    'record_sequence', 'kind', 'fingerprint', 'occurred_at',
  ]);
  requireColumns(db, 'groups', [
    'workflow_id', 'fingerprint', 'occurrences', 'latest_record_sequence',
  ]);
  requireColumns(db, 'project_groups', [
    'fingerprint', 'occurrences', 'distinct_workflows', 'latest_record_sequence',
  ]);
  requireColumns(db, 'index_state', [
    'schema_version', 'authority_size_bytes', 'authority_mtime_ms',
    'authority_ctime_ms', 'record_count', 'project_id', 'repository_id',
  ]);

  const rows = db.prepare('SELECT * FROM index_state WHERE id = 1').all();
  if (rows.length !== 1) throw new Error('Operational Memory index state is invalid');
  const row = rows[0];
  if (Number(row.schema_version) !== INDEX_SCHEMA_VERSION) {
    throw new Error('Operational Memory index schema version is incompatible');
  }
  const projectId = typeof row.project_id === 'string' && row.project_id.length > 0
    ? row.project_id
    : undefined;
  const repositoryId = typeof row.repository_id === 'string' && row.repository_id.length > 0
    ? row.repository_id
    : undefined;
  return {
    authoritySizeBytes: Number(row.authority_size_bytes),
    authorityMtimeMs: Number(row.authority_mtime_ms),
    authorityCtimeMs: Number(row.authority_ctime_ms),
    recordCount: Number(row.record_count),
    ...(projectId ? { projectId } : {}),
    ...(repositoryId ? { repositoryId } : {}),
  };
}

interface HealthyIndexAggregate {
  totalEvents: number;
  countsByKind: { error: number; limit: number; lesson: number };
  fingerprints: string[];
  lastActivityAt?: string;
}

function readHealthyAggregate(
  db: SqliteDatabase,
  state: ReadIndexState,
): HealthyIndexAggregate {
  const counts = db.prepare(`
    SELECT COUNT(*) AS total,
      SUM(CASE WHEN kind = 'error' THEN 1 ELSE 0 END) AS errors,
      SUM(CASE WHEN kind = 'limit' THEN 1 ELSE 0 END) AS limits,
      SUM(CASE WHEN kind = 'lesson' THEN 1 ELSE 0 END) AS lessons,
      MAX(occurred_at) AS last_activity
    FROM events
  `).get() ?? {};
  const totalEvents = Number(counts.total ?? 0);
  if (totalEvents !== state.recordCount) {
    throw new Error('Operational Memory index record count is inconsistent');
  }
  const fingerprints = db.prepare(
    'SELECT fingerprint FROM events GROUP BY fingerprint ORDER BY fingerprint',
  ).all().map((row) => String(row.fingerprint));
  const lastActivityAt = typeof counts.last_activity === 'string' && counts.last_activity.length > 0
    ? counts.last_activity
    : undefined;
  return {
    totalEvents,
    countsByKind: {
      error: Number(counts.errors ?? 0),
      limit: Number(counts.limits ?? 0),
      lesson: Number(counts.lessons ?? 0),
    },
    fingerprints,
    ...(lastActivityAt ? { lastActivityAt } : {}),
  };
}

function metadataMatches(
  state: ReadIndexState,
  journalStat: NonNullable<MemoryFileSet['journalStat']>,
): boolean {
  return state.authoritySizeBytes === journalStat.size &&
    state.authorityMtimeMs === journalStat.mtimeMs &&
    state.authorityCtimeMs === journalStat.ctimeMs;
}
export async function getOperationalMemoryOverview(): Promise<MemoryOverviewResponse> {
  const files = await discoverMemoryFiles();
  const health = emptyHealthCounts();
  const projectIds = new Set<string>();
  const fingerprints = new Set<string>();
  const countsByKind = { error: 0, limit: 0, lesson: 0 };
  let totalEvents = 0;
  let journalBytes = 0;
  let indexBytes = 0;
  let lastActivityAt: string | undefined;

  for (const file of files) {
    journalBytes += file.journalStat?.size ?? 0;
    indexBytes += file.indexStat?.size ?? 0;
  }

  const DatabaseSync = databaseConstructor();
  if (!DatabaseSync) {
    return {
      generatedAt: new Date().toISOString(), totalEvents: 0, uniqueFingerprints: 0,
      projectsWithMemory: 0, countsByKind, journalBytes, indexBytes,
      indexHealth: { overall: 'unavailable', ...health },
    };
  }

  for (const file of files) {
    if (file.journalStat && !file.indexStat) {
      health.missing += 1;
      continue;
    }
    if (!file.journalStat && file.indexStat) {
      health.orphaned += 1;
      continue;
    }
    if (!file.journalStat || !file.indexStat) continue;
    let db: SqliteDatabase | null = null;
    try {
      db = new DatabaseSync(file.indexPath, { readOnly: true });
      const state = readValidatedIndexState(db);
      if (!metadataMatches(state, file.journalStat)) {
        health.stale += 1;
        continue;
      }
      const aggregate = readHealthyAggregate(db, state);
      health.healthy += 1;
      totalEvents += aggregate.totalEvents;
      countsByKind.error += aggregate.countsByKind.error;
      countsByKind.limit += aggregate.countsByKind.limit;
      countsByKind.lesson += aggregate.countsByKind.lesson;
      for (const fingerprint of aggregate.fingerprints) fingerprints.add(fingerprint);
      if (state.projectId) projectIds.add(state.projectId);
      if (aggregate.lastActivityAt && (!lastActivityAt || aggregate.lastActivityAt > lastActivityAt)) {
        lastActivityAt = aggregate.lastActivityAt;
      }
    } catch {
      health.corrupt += 1;
    } finally {
      db?.close();
    }
  }

  const degraded = health.stale + health.missing + health.corrupt + health.orphaned > 0;
  return {
    generatedAt: new Date().toISOString(),
    totalEvents,
    uniqueFingerprints: fingerprints.size,
    projectsWithMemory: projectIds.size,
    countsByKind,
    journalBytes,
    indexBytes,
    ...(lastActivityAt ? { lastActivityAt } : {}),
    indexHealth: { overall: degraded ? 'degraded' : 'healthy', ...health },
  };
}


const DEFAULT_GROUP_LIMIT = 50;
const MAX_GROUP_LIMIT = 200;
const MAX_PROJECT_OPTIONS = 1000;
const MAX_FILTER_OPTIONS_PER_FIELD = 500;
const SAFE_STRUCTURAL_VALUE = /^[A-Za-z0-9_.:@+\/-]{1,160}$/;

export type MemoryItemKind = 'error' | 'limit' | 'lesson';
export type MemoryReasonCode =
  | 'approval_required' | 'policy_denied' | 'not_found' | 'permission_denied'
  | 'timeout' | 'unsupported' | 'validation_error' | 'process_exit_nonzero'
  | 'process_wait_timeout' | 'learned_pattern' | 'tool_error';

export interface MemoryGroupQuery {
  projectId?: string;
  scope?: MemoryBrowseScope;
  kind?: MemoryItemKind;
  reasonCode?: string;
  lessonCode?: string;
  sourceTool?: string;
  family?: string;
  stageId?: string;
  from?: string;
  to?: string;
  fingerprint?: string;
  minOccurrences?: number;
  limit?: number;
  cursor?: string;
}

export interface MemoryGroupItem {
  projectId?: string;
  repositoryId?: string;
  projectDisplayName?: string;
  workflowId?: string;
  scope: MemoryBrowseScope;
  fingerprint: string;
  kind: MemoryItemKind;
  reasonCode: string;
  lessonCode?: OperationalLessonCode;
  sourceTool: string;
  family: string;
  stageId?: string;
  title: string;
  lesson: string;
  occurrences: number;
  distinctWorkflows?: number;
  distinctProjects?: number;
  firstSeenAt: string;
  lastSeenAt: string;
  relevanceExplanation: string;
}

export interface MemoryFilterOptions {
  projects: Array<{ projectId: string; displayName: string }>;
  kinds: MemoryItemKind[];
  reasonCodes: string[];
  lessonCodes: string[];
  sourceTools: string[];
  families: string[];
  stageIds: string[];
  truncated: {
    projects: boolean;
    reasonCodes: boolean;
    lessonCodes: boolean;
    sourceTools: boolean;
    families: boolean;
    stageIds: boolean;
  };
}

export interface MemoryGroupPage {
  items: MemoryGroupItem[];
  nextCursor?: string;
  health: MemoryOverviewResponse['indexHealth'];
}

interface HealthyIndexDescriptor {
  indexPath: string;
  state: ReadIndexState;
}

interface HealthyIndexInspection {
  healthy: HealthyIndexDescriptor[];
  health: MemoryOverviewResponse['indexHealth'];
}

function projectDisplayName(projectId: string): string {
  return `Project ${projectId.slice(0, 8)}`;
}

function structuralValue(value: unknown): string | undefined {
  return typeof value === 'string' && SAFE_STRUCTURAL_VALUE.test(value) ? value : undefined;
}

function isMemoryKind(value: unknown): value is MemoryItemKind {
  return value === 'error' || value === 'limit' || value === 'lesson';
}

const MEMORY_REASON_CODES = new Set<MemoryReasonCode>([
  'approval_required', 'policy_denied', 'not_found', 'permission_denied', 'timeout',
  'unsupported', 'validation_error', 'process_exit_nonzero', 'process_wait_timeout',
  'learned_pattern', 'tool_error',
]);

function isMemoryReasonCode(value: unknown): value is MemoryReasonCode {
  return typeof value === 'string' && MEMORY_REASON_CODES.has(value as MemoryReasonCode);
}

function validTimestamp(value: unknown): string | undefined {
  if (typeof value !== 'string' || value.length > 64 || Number.isNaN(Date.parse(value))) return undefined;
  return value;
}

function normalizeGroupLimit(value: number | undefined): number {
  if (value === undefined) return DEFAULT_GROUP_LIMIT;
  if (!Number.isFinite(value) || value <= 0) return DEFAULT_GROUP_LIMIT;
  return Math.min(MAX_GROUP_LIMIT, Math.max(1, Math.floor(value)));
}

function normalizeMinOccurrences(value: number | undefined): number | undefined {
  if (value === undefined) return undefined;
  if (!Number.isFinite(value) || value < 1) return 1;
  return Math.floor(value);
}

async function inspectHealthyIndexes(): Promise<HealthyIndexInspection> {
  const files = await discoverMemoryFiles();
  const counts = emptyHealthCounts();
  const DatabaseSync = databaseConstructor();
  if (!DatabaseSync) return { healthy: [], health: { overall: 'unavailable', ...counts } };
  const healthy: HealthyIndexDescriptor[] = [];
  for (const file of files) {
    if (file.journalStat && !file.indexStat) { counts.missing += 1; continue; }
    if (!file.journalStat && file.indexStat) { counts.orphaned += 1; continue; }
    if (!file.journalStat || !file.indexStat) continue;
    let db: SqliteDatabase | null = null;
    try {
      db = new DatabaseSync(file.indexPath, { readOnly: true });
      const state = readValidatedIndexState(db);
      if (!metadataMatches(state, file.journalStat)) { counts.stale += 1; continue; }
      readHealthyAggregate(db, state);
      counts.healthy += 1;
      healthy.push({ indexPath: file.indexPath, state });
    } catch {
      counts.corrupt += 1;
    } finally {
      db?.close();
    }
  }
  const degraded = counts.stale + counts.missing + counts.corrupt + counts.orphaned > 0;
  return { healthy, health: { overall: degraded ? 'degraded' : 'healthy', ...counts } };
}

function titleFor(sourceTool: string, reasonCode: MemoryReasonCode, lessonCode?: OperationalLessonCode): string {
  if (reasonCode === 'learned_pattern' && lessonCode) {
    return OPERATIONAL_LESSON_TEMPLATES[lessonCode].summary;
  }
  switch (reasonCode) {
    case 'approval_required': return `${sourceTool} stopped because human approval is required.`;
    case 'policy_denied': return `${sourceTool} was blocked by policy.`;
    case 'not_found': return `${sourceTool} failed because the requested resource was not found.`;
    case 'permission_denied': return `${sourceTool} failed because the operating system denied access.`;
    case 'timeout': return `${sourceTool} failed because the operation timed out.`;
    case 'unsupported': return `${sourceTool} failed because the operation is unsupported.`;
    case 'validation_error': return `${sourceTool} failed because its arguments were rejected.`;
    case 'process_exit_nonzero': return `${sourceTool} observed a process that completed with a non-zero exit code.`;
    case 'process_wait_timeout': return `${sourceTool} reached its wait timeout while the process remained active.`;
    default: return `${sourceTool} failed during the previous attempt.`;
  }
}

function lessonFor(reasonCode: MemoryReasonCode, lessonCode?: OperationalLessonCode): string {
  if (reasonCode === 'learned_pattern' && lessonCode) {
    return OPERATIONAL_LESSON_TEMPLATES[lessonCode].lesson;
  }
  switch (reasonCode) {
    case 'approval_required': return 'Do not retry the same protected action until a matching human approval exists.';
    case 'policy_denied': return 'Do not bypass or repeatedly retry a policy-blocked action; choose an allowed action or ask for an explicit policy change.';
    case 'not_found': return 'Re-check the resource path and current state before retrying.';
    case 'permission_denied': return 'Verify permissions or choose an accessible resource before retrying.';
    case 'timeout': return 'Check process state or reduce the operation scope before retrying.';
    case 'unsupported': return 'Use a supported alternative instead of repeating the unsupported operation.';
    case 'validation_error': return 'Correct the rejected arguments before retrying the operation.';
    case 'process_exit_nonzero': return 'Inspect the completed process exit evidence before retrying or changing the command.';
    case 'process_wait_timeout': return 'A tool wait timeout does not prove the process or test failed; inspect process completion and exit evidence.';
    default: return 'Inspect current state and avoid repeating the identical failed call unchanged.';
  }
}

function relevanceFor(item: Pick<MemoryGroupItem, 'scope' | 'occurrences' | 'distinctWorkflows' | 'distinctProjects'>): string {
  if (item.scope === 'global') {
    return `Safe server-defined lesson observed across ${item.distinctProjects ?? 0} projects.`;
  }
  if (item.scope === 'project') {
    return `${item.occurrences} occurrences across ${item.distinctWorkflows ?? 0} workflows in this project.`;
  }
  return `${item.occurrences} occurrences in this workflow.`;
}

interface ParsedGroupRow {
  workflowId?: string;
  fingerprint: string;
  kind: MemoryItemKind;
  reasonCode: MemoryReasonCode;
  lessonCode?: OperationalLessonCode;
  sourceTool: string;
  family: string;
  stageId?: string;
  firstSeenAt: string;
  lastSeenAt: string;
  occurrences: number;
  distinctWorkflows?: number;
}

function parseGroupRow(row: Record<string, unknown>, workflowScope: boolean): ParsedGroupRow | null {
  const fingerprint = structuralValue(row.fingerprint);
  const kind = row.kind;
  const reasonCode = row.reason_code;
  const sourceTool = structuralValue(row.source_tool);
  const family = structuralValue(row.family);
  const firstSeenAt = validTimestamp(row.first_seen_at);
  const lastSeenAt = validTimestamp(row.last_seen_at);
  const occurrences = Number(row.occurrences);
  if (!fingerprint || !isMemoryKind(kind) || !isMemoryReasonCode(reasonCode) || !sourceTool || !family ||
      !firstSeenAt || !lastSeenAt || !Number.isSafeInteger(occurrences) || occurrences < 1) return null;
  const rawStage = row.stage_id;
  const stageId = rawStage === null || rawStage === undefined || rawStage === ''
    ? undefined : structuralValue(rawStage);
  if (rawStage !== null && rawStage !== undefined && rawStage !== '' && !stageId) return null;
  const rawLesson = row.lesson_code;
  let lessonCode: OperationalLessonCode | undefined;
  if (rawLesson !== null && rawLesson !== undefined && rawLesson !== '') {
    const value = String(rawLesson);
    if (!isOperationalLessonCode(value)) return null;
    lessonCode = value;
  }
  if (reasonCode === 'learned_pattern' && !lessonCode) return null;
  const workflowId = workflowScope ? structuralValue(row.workflow_id) : undefined;
  if (workflowScope && !workflowId) return null;
  let distinctWorkflows: number | undefined;
  if (!workflowScope) {
    const value = Number(row.distinct_workflows);
    if (!Number.isSafeInteger(value) || value < 1) return null;
    distinctWorkflows = value;
  }
  return {
    ...(workflowId ? { workflowId } : {}), fingerprint, kind, reasonCode,
    ...(lessonCode ? { lessonCode } : {}), sourceTool, family,
    ...(stageId ? { stageId } : {}), firstSeenAt, lastSeenAt, occurrences,
    ...(distinctWorkflows !== undefined ? { distinctWorkflows } : {}),
  };
}

function validateDateFilter(value: string | undefined): void {
  if (value !== undefined && (value.length > 64 || Number.isNaN(Date.parse(value)))) {
    throw new Error('Invalid memory date filter');
  }
}

function buildGroupWhere(query: MemoryGroupQuery): { sql: string; params: unknown[] } {
  validateDateFilter(query.from);
  validateDateFilter(query.to);
  const clauses: string[] = [];
  const params: unknown[] = [];
  const add = (column: string, value: unknown) => {
    if (value === undefined) return;
    clauses.push(`${column} = ?`);
    params.push(value);
  };
  add('kind', query.kind);
  add('reason_code', query.reasonCode);
  add('lesson_code', query.lessonCode);
  add('source_tool', query.sourceTool);
  add('family', query.family);
  add('stage_id', query.stageId);
  add('fingerprint', query.fingerprint);
  if (query.from !== undefined) { clauses.push('last_seen_at >= ?'); params.push(query.from); }
  if (query.to !== undefined) { clauses.push('last_seen_at <= ?'); params.push(query.to); }
  return { sql: clauses.length ? ` WHERE ${clauses.join(' AND ')}` : '', params };
}

function makeGroupItem(
  scope: 'project' | 'workflow',
  state: ReadIndexState,
  row: ParsedGroupRow,
): MemoryGroupItem | null {
  const projectId = structuralValue(state.projectId);
  if (!projectId) return null;
  const repositoryId = state.repositoryId ? structuralValue(state.repositoryId) : undefined;
  const base: MemoryGroupItem = {
    projectId,
    ...(repositoryId ? { repositoryId } : {}),
    projectDisplayName: projectDisplayName(projectId),
    ...(row.workflowId ? { workflowId: row.workflowId } : {}),
    scope,
    fingerprint: row.fingerprint,
    kind: row.kind,
    reasonCode: row.reasonCode,
    ...(row.lessonCode ? { lessonCode: row.lessonCode } : {}),
    sourceTool: row.sourceTool,
    family: row.family,
    ...(row.stageId ? { stageId: row.stageId } : {}),
    title: titleFor(row.sourceTool, row.reasonCode, row.lessonCode),
    lesson: lessonFor(row.reasonCode, row.lessonCode),
    occurrences: row.occurrences,
    ...(row.distinctWorkflows !== undefined ? { distinctWorkflows: row.distinctWorkflows } : {}),
    firstSeenAt: row.firstSeenAt,
    lastSeenAt: row.lastSeenAt,
    relevanceExplanation: '',
  };
  base.relevanceExplanation = relevanceFor(base);
  return base;
}

function mergeGroup(existing: MemoryGroupItem, incoming: MemoryGroupItem): void {
  existing.occurrences += incoming.occurrences;
  if (existing.scope === 'project') {
    existing.distinctWorkflows = (existing.distinctWorkflows ?? 0) + (incoming.distinctWorkflows ?? 0);
  }
  if (incoming.firstSeenAt < existing.firstSeenAt) existing.firstSeenAt = incoming.firstSeenAt;
  if (incoming.lastSeenAt > existing.lastSeenAt) {
    existing.lastSeenAt = incoming.lastSeenAt;
    existing.repositoryId = incoming.repositoryId;
    existing.sourceTool = incoming.sourceTool;
    existing.family = incoming.family;
    existing.stageId = incoming.stageId;
    existing.kind = incoming.kind;
    existing.reasonCode = incoming.reasonCode;
    existing.lessonCode = incoming.lessonCode;
    existing.title = incoming.title;
    existing.lesson = incoming.lesson;
  }
  existing.relevanceExplanation = relevanceFor(existing);
}

async function collectIndexedGroups(
  inspection: HealthyIndexInspection,
  query: MemoryGroupQuery,
  scope: 'project' | 'workflow',
): Promise<MemoryGroupItem[]> {
  const DatabaseSync = databaseConstructor();
  if (!DatabaseSync) return [];
  const merged = new Map<string, MemoryGroupItem>();
  const where = buildGroupWhere(query);
  const table = scope === 'project' ? 'project_groups' : 'groups';
  for (const descriptor of inspection.healthy) {
    const projectId = structuralValue(descriptor.state.projectId);
    if (!projectId || (query.projectId !== undefined && query.projectId !== projectId)) continue;
    let db: SqliteDatabase | null = null;
    try {
      db = new DatabaseSync(descriptor.indexPath, { readOnly: true });
      const rows = db.prepare(`SELECT * FROM ${table}${where.sql}`).all(...where.params);
      for (const raw of rows) {
        const parsed = parseGroupRow(raw, scope === 'workflow');
        if (!parsed) continue;
        const item = makeGroupItem(scope, descriptor.state, parsed);
        if (!item) continue;
        const key = scope === 'project'
          ? `${projectId}\u0000${item.fingerprint}`
          : `${projectId}\u0000${item.workflowId ?? ''}\u0000${item.fingerprint}`;
        const existing = merged.get(key);
        if (existing) mergeGroup(existing, item); else merged.set(key, item);
      }
    } catch {
      continue;
    } finally {
      db?.close();
    }
  }
  return [...merged.values()];
}

async function collectGlobalGroups(): Promise<MemoryGroupItem[]> {
  const rows = await readOperationalMemoryGlobalGroupsReadOnly();
  const result: MemoryGroupItem[] = [];
  for (const row of rows) {
    const fingerprint = structuralValue(row.fingerprint);
    const firstSeenAt = validTimestamp(row.firstSeenAt);
    const lastSeenAt = validTimestamp(row.lastSeenAt);
    const occurrences = Number(row.occurrences);
    const distinctProjects = Number(row.distinctProjects);
    if (!fingerprint || !isOperationalLessonCode(row.lessonCode) || !firstSeenAt || !lastSeenAt ||
        !Number.isSafeInteger(occurrences) || occurrences < 1 ||
        !Number.isSafeInteger(distinctProjects) || distinctProjects < 1) continue;
    const lessonCode = row.lessonCode;
    const item: MemoryGroupItem = {
      scope: 'global', fingerprint, kind: 'lesson', reasonCode: 'learned_pattern', lessonCode,
      sourceTool: 'project_workflow', family: 'workflow',
      title: OPERATIONAL_LESSON_TEMPLATES[lessonCode].summary,
      lesson: OPERATIONAL_LESSON_TEMPLATES[lessonCode].lesson,
      occurrences, distinctProjects, firstSeenAt, lastSeenAt, relevanceExplanation: '',
    };
    item.relevanceExplanation = relevanceFor(item);
    result.push(item);
  }
  return result;
}

function matchesGroupFilters(item: MemoryGroupItem, query: MemoryGroupQuery): boolean {
  if (query.projectId !== undefined && item.projectId !== query.projectId) return false;
  if (query.kind !== undefined && item.kind !== query.kind) return false;
  if (query.reasonCode !== undefined && item.reasonCode !== query.reasonCode) return false;
  if (query.lessonCode !== undefined && item.lessonCode !== query.lessonCode) return false;
  if (query.sourceTool !== undefined && item.sourceTool !== query.sourceTool) return false;
  if (query.family !== undefined && item.family !== query.family) return false;
  if (query.stageId !== undefined && item.stageId !== query.stageId) return false;
  if (query.fingerprint !== undefined && item.fingerprint !== query.fingerprint) return false;
  if (query.from !== undefined && item.lastSeenAt < query.from) return false;
  if (query.to !== undefined && item.lastSeenAt > query.to) return false;
  const minOccurrences = normalizeMinOccurrences(query.minOccurrences);
  if (minOccurrences !== undefined && item.occurrences < minOccurrences) return false;
  return true;
}

type GroupCursorTuple = [1, string, string, string, string, MemoryBrowseScope];

function compareText(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

function groupSortTuple(item: MemoryGroupItem): GroupCursorTuple {
  return [
    1,
    item.lastSeenAt,
    item.projectId ?? '',
    item.workflowId ?? '',
    item.fingerprint,
    item.scope,
  ];
}

function compareGroupTuple(a: GroupCursorTuple, b: GroupCursorTuple): number {
  if (a[1] !== b[1]) return a[1] > b[1] ? -1 : 1;
  for (const index of [2, 3, 4, 5] as const) {
    const compared = compareText(a[index], b[index]);
    if (compared !== 0) return compared;
  }
  return 0;
}

function encodeGroupCursor(item: MemoryGroupItem): string {
  return Buffer.from(JSON.stringify(groupSortTuple(item)), 'utf8').toString('base64url');
}

function decodeGroupCursor(cursor: string, scope: MemoryBrowseScope): GroupCursorTuple {
  try {
    if (cursor.length < 4 || cursor.length > 1024) throw new Error('invalid');
    const parsed = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8')) as unknown;
    if (!Array.isArray(parsed) || parsed.length !== 6 || parsed[0] !== 1) throw new Error('invalid');
    const [version, lastSeenAt, projectId, workflowId, fingerprint, cursorScope] = parsed;
    if (version !== 1 || !validTimestamp(lastSeenAt) || typeof projectId !== 'string' ||
        typeof workflowId !== 'string' || !structuralValue(fingerprint) ||
        (projectId !== '' && !structuralValue(projectId)) ||
        (workflowId !== '' && !structuralValue(workflowId)) ||
        (cursorScope !== 'workflow' && cursorScope !== 'project' && cursorScope !== 'global') ||
        cursorScope !== scope) throw new Error('invalid');
    return [1, lastSeenAt, projectId, workflowId, fingerprint, cursorScope];
  } catch {
    throw new Error('Invalid memory cursor');
  }
}

function validateGroupScope(scope: unknown): asserts scope is MemoryBrowseScope {
  if (scope !== 'workflow' && scope !== 'project' && scope !== 'global') {
    throw new Error('Invalid memory scope');
  }
}

export async function queryOperationalMemoryGroups(
  query: MemoryGroupQuery = {},
): Promise<MemoryGroupPage> {
  const scope = query.scope ?? 'project';
  validateGroupScope(scope);
  validateDateFilter(query.from);
  validateDateFilter(query.to);
  const inspection = await inspectHealthyIndexes();
  let items = scope === 'global'
    ? await collectGlobalGroups()
    : await collectIndexedGroups(inspection, query, scope);
  items = items.filter((item) => matchesGroupFilters(item, query));
  items.sort((a, b) => compareGroupTuple(groupSortTuple(a), groupSortTuple(b)));

  if (query.cursor !== undefined) {
    const cursor = decodeGroupCursor(query.cursor, scope);
    items = items.filter((item) => compareGroupTuple(groupSortTuple(item), cursor) > 0);
  }
  const limit = normalizeGroupLimit(query.limit);
  const hasMore = items.length > limit;
  const pageItems = items.slice(0, limit);
  return {
    items: pageItems,
    ...(hasMore && pageItems.length > 0
      ? { nextCursor: encodeGroupCursor(pageItems[pageItems.length - 1]) }
      : {}),
    health: inspection.health,
  };
}

export interface MemoryEventQuery {
  fingerprint: string; projectId?: string; workflowId?: string; scope: MemoryBrowseScope;
  from?: string; to?: string; limit?: number; cursor?: string;
}
export interface MemoryEventItem {
  projectId?: string; repositoryId?: string; workflowId: string; taskId?: string; runId?: string;
  kind: MemoryItemKind; reasonCode: string; lessonCode?: OperationalLessonCode;
  sourceTool: string; family: string; stageId?: string; fingerprint: string; occurredAt: string;
}
export interface MemoryEventPage {
  items: MemoryEventItem[]; nextCursor?: string; health: MemoryOverviewResponse['indexHealth'];
}
interface InternalMemoryEventItem extends MemoryEventItem { recordSequence: number; }
type EventCursorTuple = [1, string, string, string, number, string, MemoryBrowseScope];
const DEFAULT_EVENT_LIMIT = 50;
const MAX_EVENT_LIMIT = 200;
function normalizeEventLimit(value: number | undefined): number {
  if (value === undefined || !Number.isFinite(value) || value <= 0) return DEFAULT_EVENT_LIMIT;
  return Math.min(MAX_EVENT_LIMIT, Math.max(1, Math.floor(value)));
}
function optionalStructuralValue(value: unknown): string | undefined {
  if (value === null || value === undefined || value === '') return undefined;
  return structuralValue(value);
}
function parseEventRow(row: Record<string, unknown>, state: ReadIndexState): InternalMemoryEventItem | null {
  const projectId = structuralValue(state.projectId); const workflowId = structuralValue(row.workflow_id);
  const fingerprint = structuralValue(row.fingerprint); const sourceTool = structuralValue(row.source_tool);
  const family = structuralValue(row.family); const occurredAt = validTimestamp(row.occurred_at);
  const recordSequence = Number(row.record_sequence); const kind = row.kind; const reasonCode = row.reason_code;  if (!projectId || !workflowId || !fingerprint || !sourceTool || !family || !occurredAt ||
      !isMemoryKind(kind) || !isMemoryReasonCode(reasonCode) ||
      !Number.isSafeInteger(recordSequence) || recordSequence < 1) return null;
  const rawLesson = row.lesson_code; let lessonCode: OperationalLessonCode | undefined;
  if (rawLesson !== null && rawLesson !== undefined && rawLesson !== '') {
    const value = String(rawLesson); if (!isOperationalLessonCode(value)) return null; lessonCode = value;
  }
  if (reasonCode === 'learned_pattern' && !lessonCode) return null;
  const repositoryId = optionalStructuralValue(state.repositoryId);
  const taskId = optionalStructuralValue(row.task_id); const runId = optionalStructuralValue(row.run_id);
  const stageId = optionalStructuralValue(row.stage_id);
  return { projectId, ...(repositoryId ? { repositoryId } : {}), workflowId,
    ...(taskId ? { taskId } : {}), ...(runId ? { runId } : {}), kind, reasonCode,
    ...(lessonCode ? { lessonCode } : {}), sourceTool, family, ...(stageId ? { stageId } : {}),
    fingerprint, occurredAt, recordSequence };
}
function eventTuple(item: InternalMemoryEventItem, scope: MemoryBrowseScope): EventCursorTuple {
  return [1, item.occurredAt, item.projectId ?? '', item.workflowId,
    item.recordSequence, item.fingerprint, scope];
}
function compareEventTuple(a: EventCursorTuple, b: EventCursorTuple): number {
  if (a[1] !== b[1]) return a[1] > b[1] ? -1 : 1;
  for (const index of [2, 3] as const) { const c = compareText(a[index], b[index]); if (c) return c; }
  if (a[4] !== b[4]) return a[4] > b[4] ? -1 : 1;
  const fingerprintCompared = compareText(a[5], b[5]);
  return fingerprintCompared || compareText(a[6], b[6]);
}
function encodeEventCursor(item: InternalMemoryEventItem, scope: MemoryBrowseScope): string {
  return Buffer.from(JSON.stringify(eventTuple(item, scope)), 'utf8').toString('base64url');
}function decodeEventCursor(cursor: string, scope: MemoryBrowseScope, fingerprint: string): EventCursorTuple {
  try {
    if (cursor.length < 4 || cursor.length > 1536) throw new Error('invalid');
    const parsed = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8')) as unknown;
    if (!Array.isArray(parsed) || parsed.length !== 7 || parsed[0] !== 1) throw new Error('invalid');
    const [version, occurredAt, projectId, workflowId, recordSequence, cursorFingerprint, cursorScope] = parsed;
    if (version !== 1 || !validTimestamp(occurredAt) || typeof projectId !== 'string' ||
        (projectId !== '' && !structuralValue(projectId)) || !structuralValue(workflowId) ||
        !Number.isSafeInteger(recordSequence) || recordSequence < 1 ||
        structuralValue(cursorFingerprint) !== fingerprint || cursorScope !== scope) throw new Error('invalid');
    return [1, occurredAt, projectId, workflowId, recordSequence, cursorFingerprint, cursorScope];
  } catch { throw new Error('Invalid memory event cursor'); }
}
function validateEventQuery(query: MemoryEventQuery) {
  validateGroupScope(query.scope); const fingerprint = structuralValue(query.fingerprint);
  if (!fingerprint) throw new Error('Invalid memory fingerprint');
  validateDateFilter(query.from); validateDateFilter(query.to);
  if (query.from && query.to && query.from > query.to) throw new Error('Invalid memory date range');
  if (query.scope === 'global') {
    if (query.projectId !== undefined || query.workflowId !== undefined)
      throw new Error('Global memory drill-down cannot select a project or workflow');
    return { scope: query.scope, fingerprint };
  }
  const projectId = structuralValue(query.projectId); if (!projectId) throw new Error('Memory project is required');
  if (query.scope === 'project' && query.workflowId !== undefined)
    throw new Error('Project memory drill-down cannot select a workflow');
  const workflowId = query.workflowId === undefined ? undefined : structuralValue(query.workflowId);
  if (query.workflowId !== undefined && !workflowId) throw new Error('Invalid memory workflow');
  return { scope: query.scope, fingerprint, projectId, ...(workflowId ? { workflowId } : {}) };
}function cursorSql(cursor: EventCursorTuple | undefined, projectId: string) {
  if (!cursor) return { sql: '', params: [] as unknown[] };
  const time = cursor[1]; const cursorProject = cursor[2]; const workflow = cursor[3]; const sequence = cursor[4];
  const projectCompared = compareText(projectId, cursorProject);
  if (projectCompared < 0) return { sql: ' AND e.occurred_at < ?', params: [time] };
  if (projectCompared > 0) return { sql: ' AND e.occurred_at <= ?', params: [time] };
  return { sql: ' AND (e.occurred_at < ? OR (e.occurred_at = ? AND (e.workflow_id > ? OR (e.workflow_id = ? AND e.record_sequence < ?))))',
    params: [time, time, workflow, workflow, sequence] };
}
function readEventPageFromIndex(db: SqliteDatabase, descriptor: HealthyIndexDescriptor,
  query: MemoryEventQuery, workflowId: string | undefined, cursor: EventCursorTuple | undefined, limit: number) {
  const projectId = structuralValue(descriptor.state.projectId); if (!projectId) return [];
  const clauses = ['g.fingerprint = ?']; const params: unknown[] = [query.fingerprint];
  if (workflowId) { clauses.push('g.workflow_id = ?'); params.push(workflowId); }
  if (query.from !== undefined) { clauses.push('e.occurred_at >= ?'); params.push(query.from); }
  if (query.to !== undefined) { clauses.push('e.occurred_at <= ?'); params.push(query.to); }
  const after = cursorSql(cursor, projectId);
  const sql = 'SELECT e.record_sequence, e.workflow_id, e.task_id, e.run_id, e.kind, e.reason_code, ' +
    'e.lesson_code, e.source_tool, e.family, e.stage_id, e.fingerprint, e.occurred_at ' +
    'FROM groups g JOIN events e ON e.workflow_id = g.workflow_id AND e.fingerprint = g.fingerprint ' +
    'WHERE ' + clauses.join(' AND ') + after.sql +
    ' ORDER BY e.occurred_at DESC, e.workflow_id ASC, e.record_sequence DESC LIMIT ?';
  return db.prepare(sql).all(...params, ...after.params, limit + 1).flatMap((row) => {
    const parsed = parseEventRow(row, descriptor.state); return parsed ? [parsed] : [];
  });
}
function eventDedupKey(item: InternalMemoryEventItem): string {
  return [item.projectId ?? '', item.workflowId, item.recordSequence, item.fingerprint, item.occurredAt].join('\u0000');
}function safeGlobalEvent(item: InternalMemoryEventItem, lessonCode: OperationalLessonCode): boolean {
  return item.kind === 'lesson' && item.reasonCode === 'learned_pattern' && item.lessonCode === lessonCode &&
    item.sourceTool === 'project_workflow' && item.family === 'workflow';
}
function publicEvent(item: InternalMemoryEventItem): MemoryEventItem {
  const { recordSequence: _recordSequence, ...result } = item; return result;
}
export async function queryOperationalMemoryEvents(query: MemoryEventQuery): Promise<MemoryEventPage> {
  const validated = validateEventQuery(query); const inspection = await inspectHealthyIndexes();
  const limit = normalizeEventLimit(query.limit);
  const cursor = query.cursor ? decodeEventCursor(query.cursor, validated.scope, validated.fingerprint) : undefined;
  let globalLessonCode: OperationalLessonCode | undefined;
  if (validated.scope === 'global') {
    const candidates = (await collectGlobalGroups()).filter((item) =>
      item.fingerprint === validated.fingerprint && item.lessonCode);
    if (candidates.length !== 1 || !candidates[0].lessonCode) return { items: [], health: inspection.health };
    globalLessonCode = candidates[0].lessonCode;
  }
  const DatabaseSync = databaseConstructor(); if (!DatabaseSync) return { items: [], health: inspection.health };
  const deduped = new Map<string, InternalMemoryEventItem>();
  for (const descriptor of inspection.healthy) {
    const projectId = structuralValue(descriptor.state.projectId); if (!projectId) continue;
    if (validated.scope !== 'global' && projectId !== validated.projectId) continue;
    if (validated.scope === 'global') {
      if (!globalLessonCode) continue;
      const isAuthoritativeProject = await hasOperationalMemoryGlobalProjectLessonReadOnly(
        { projectId: descriptor.state.projectId, repositoryId: descriptor.state.repositoryId },
        validated.fingerprint,
        globalLessonCode,
      );
      if (!isAuthoritativeProject) continue;
    }
    let db: SqliteDatabase | null = null;
    try {
      db = new DatabaseSync(descriptor.indexPath, { readOnly: true });
      const rows = readEventPageFromIndex(db, descriptor, query,
        validated.scope === 'workflow' ? validated.workflowId : undefined, cursor, limit);
      for (const item of rows) {
        if (validated.scope === 'global' && (!globalLessonCode || !safeGlobalEvent(item, globalLessonCode))) continue;
        deduped.set(eventDedupKey(item), item);
      }
    } catch { continue; } finally { db?.close(); }
  }  let items = [...deduped.values()];
  items.sort((a, b) => compareEventTuple(eventTuple(a, validated.scope), eventTuple(b, validated.scope)));
  if (cursor) items = items.filter((item) => compareEventTuple(eventTuple(item, validated.scope), cursor) > 0);
  const hasMore = items.length > limit; const pageItems = items.slice(0, limit);
  return { items: pageItems.map(publicEvent),
    ...(hasMore && pageItems.length > 0
      ? { nextCursor: encodeEventCursor(pageItems[pageItems.length - 1], validated.scope) } : {}),
    health: inspection.health };
}

function boundedSorted(values: Set<string>, max: number): { values: string[]; truncated: boolean } {
  const sorted = [...values].sort(compareText);
  return { values: sorted.slice(0, max), truncated: sorted.length > max };
}

export async function getOperationalMemoryFilterOptions(): Promise<MemoryFilterOptions> {
  const inspection = await inspectHealthyIndexes();
  const projects = new Map<string, string>();
  const reasonCodes = new Set<string>();
  const lessonCodes = new Set<string>();
  const sourceTools = new Set<string>();
  const families = new Set<string>();
  const stageIds = new Set<string>();
  const DatabaseSync = databaseConstructor();

  if (DatabaseSync) {
    for (const descriptor of inspection.healthy) {
      const projectId = structuralValue(descriptor.state.projectId);
      if (projectId) projects.set(projectId, projectDisplayName(projectId));
      let db: SqliteDatabase | null = null;
      try {
        db = new DatabaseSync(descriptor.indexPath, { readOnly: true });
        const rows = db.prepare('SELECT * FROM project_groups').all();
        for (const raw of rows) {
          const parsed = parseGroupRow(raw, false);
          if (!parsed) continue;
          reasonCodes.add(parsed.reasonCode);
          if (parsed.lessonCode) lessonCodes.add(parsed.lessonCode);
          sourceTools.add(parsed.sourceTool);
          families.add(parsed.family);
          if (parsed.stageId) stageIds.add(parsed.stageId);
        }
      } catch {
        continue;
      } finally {
        db?.close();
      }
    }
  }

  const globals = await readOperationalMemoryGlobalGroupsReadOnly();
  if (globals.length > 0) {
    reasonCodes.add('learned_pattern');
    sourceTools.add('project_workflow');
    families.add('workflow');
    for (const group of globals) {
      if (isOperationalLessonCode(group.lessonCode)) lessonCodes.add(group.lessonCode);
    }
  }

  const projectEntries = [...projects.entries()]
    .sort(([a], [b]) => compareText(a, b))
    .map(([projectId, displayName]) => ({ projectId, displayName }));
  const reason = boundedSorted(reasonCodes, MAX_FILTER_OPTIONS_PER_FIELD);
  const lesson = boundedSorted(lessonCodes, MAX_FILTER_OPTIONS_PER_FIELD);
  const tools = boundedSorted(sourceTools, MAX_FILTER_OPTIONS_PER_FIELD);
  const family = boundedSorted(families, MAX_FILTER_OPTIONS_PER_FIELD);
  const stages = boundedSorted(stageIds, MAX_FILTER_OPTIONS_PER_FIELD);
  return {
    projects: projectEntries.slice(0, MAX_PROJECT_OPTIONS),
    kinds: ['error', 'limit', 'lesson'],
    reasonCodes: reason.values,
    lessonCodes: lesson.values,
    sourceTools: tools.values,
    families: family.values,
    stageIds: stages.values,
    truncated: {
      projects: projectEntries.length > MAX_PROJECT_OPTIONS,
      reasonCodes: reason.truncated,
      lessonCodes: lesson.truncated,
      sourceTools: tools.truncated,
      families: family.truncated,
      stageIds: stages.truncated,
    },
  };
}
