import type { Stats } from 'node:fs';
import { createRequire } from 'node:module';
import fs from 'node:fs/promises';
import path from 'node:path';

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
    'authority_ctime_ms', 'record_count', 'project_id',
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
  return {
    authoritySizeBytes: Number(row.authority_size_bytes),
    authorityMtimeMs: Number(row.authority_mtime_ms),
    authorityCtimeMs: Number(row.authority_ctime_ms),
    recordCount: Number(row.record_count),
    ...(projectId ? { projectId } : {}),
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
