import crypto from 'node:crypto';
import { createReadStream } from 'node:fs';
import fs from 'node:fs/promises';
import { createRequire } from 'node:module';
import path from 'node:path';
import readline from 'node:readline';
import { setTimeout as delay } from 'node:timers/promises';

import { isOperationalLessonCode } from './operational-memory-contract.js';
import {
  readOperationalMemoryIndexCorrelation,
  type IndexableOperationalMemoryEvent,
  type OperationalMemoryScopeCorrelation,
} from './operational-memory-index.js';
import { resolveWorkflowStateRoot } from './workflow-storage.js';

const GLOBAL_INDEX_SCHEMA_VERSION = 1;
const GLOBAL_INDEX_FILENAME = 'operational-memory.global.sqlite';
const GLOBAL_LOCK_NAME = 'operational-memory.global.lock';
const GLOBAL_LOCK_RETRY_MS = 25;
const GLOBAL_LOCK_ATTEMPTS = 200;
const GLOBAL_STALE_LOCK_MS = 30_000;
const runtimeRequire = createRequire(import.meta.url);

export type OperationalMemoryGlobalLineParser = (
  line: string,
) => IndexableOperationalMemoryEvent | null;

export interface IndexedOperationalMemoryGlobalGroup {
  fingerprint: string;
  lessonCode: string;
  firstSeenAt: string;
  lastSeenAt: string;
  occurrences: number;
  distinctProjects: number;
}

interface SqliteStatement {
  run(...params: unknown[]): { changes: number | bigint };
  get(...params: unknown[]): Record<string, unknown> | undefined;
  all(...params: unknown[]): Array<Record<string, unknown>>;
}

interface SqliteDatabase {
  exec(sql: string): void;
  prepare(sql: string): SqliteStatement;
  close(): void;
}

interface SqliteModule {
  DatabaseSync?: new (location: string, options?: { readOnly?: boolean }) => SqliteDatabase;
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

function digest(value: string): string {
  return crypto.createHash('sha256').update(value).digest('hex').slice(0, 24);
}

function sourceIdForMemoryPath(memoryPath: string): string {
  return digest('global-source:' + path.basename(memoryPath));
}

function projectKey(scope: OperationalMemoryScopeCorrelation): string | null {
  if (!scope.projectId) return null;
  return digest('global-project:' + scope.projectId + '|' + (scope.repositoryId ?? ''));
}

export function resolveOperationalMemoryGlobalIndexPath(): string {
  return path.join(resolveWorkflowStateRoot(), GLOBAL_INDEX_FILENAME);
}

function openDatabase(indexPath: string, readOnly = false): SqliteDatabase | null {
  const DatabaseSync = databaseConstructor();
  if (!DatabaseSync) return null;
  try {
    return readOnly ? new DatabaseSync(indexPath, { readOnly: true }) : new DatabaseSync(indexPath);
  } catch {
    return null;
  }
}

function initializeSchema(db: SqliteDatabase): void {
  db.exec(`
    PRAGMA busy_timeout = 1500;
    CREATE TABLE IF NOT EXISTS global_sources (
      source_id TEXT PRIMARY KEY,
      project_key TEXT NOT NULL,
      authority_size_bytes INTEGER NOT NULL,
      authority_mtime_ms REAL NOT NULL,
      authority_ctime_ms REAL NOT NULL
    );
    CREATE TABLE IF NOT EXISTS global_project_lessons (
      project_key TEXT NOT NULL,
      fingerprint TEXT NOT NULL,
      lesson_code TEXT NOT NULL,
      first_seen_at TEXT NOT NULL,
      last_seen_at TEXT NOT NULL,
      occurrences INTEGER NOT NULL,
      PRIMARY KEY (project_key, fingerprint)
    );
    CREATE TABLE IF NOT EXISTS global_state (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      schema_version INTEGER NOT NULL
    );
    INSERT INTO global_state (id, schema_version)
      VALUES (1, ${GLOBAL_INDEX_SCHEMA_VERSION})
      ON CONFLICT(id) DO NOTHING;
  `);
}

function validateSchema(db: SqliteDatabase): void {
  const state = db.prepare('SELECT schema_version FROM global_state WHERE id = 1').get();
  if (!state || Number(state.schema_version) !== GLOBAL_INDEX_SCHEMA_VERSION) {
    throw new Error('Operational Memory global index schema is incompatible');
  }
  const sourceColumns = new Set(
    db.prepare('PRAGMA table_info(global_sources)').all().map((row) => String(row.name)),
  );
  for (const column of ['source_id', 'project_key', 'authority_size_bytes', 'authority_mtime_ms', 'authority_ctime_ms']) {
    if (!sourceColumns.has(column)) throw new Error('Operational Memory global source schema is incompatible');
  }
  const lessonColumns = new Set(
    db.prepare('PRAGMA table_info(global_project_lessons)').all().map((row) => String(row.name)),
  );
  for (const column of ['project_key', 'fingerprint', 'lesson_code', 'first_seen_at', 'last_seen_at', 'occurrences']) {
    if (!lessonColumns.has(column)) throw new Error('Operational Memory global lesson schema is incompatible');
  }
}

async function recoverStaleGlobalLock(lockPath: string): Promise<boolean> {
  const stat = await fs.stat(lockPath).catch((error) => {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  });
  if (!stat) return true;
  if (Date.now() - stat.mtimeMs <= GLOBAL_STALE_LOCK_MS) return false;

  const reclaimedPath = lockPath + '.stale-' + process.pid + '-' + crypto.randomUUID();
  try {
    await fs.rename(lockPath, reclaimedPath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return true;
    throw error;
  }
  await fs.rm(reclaimedPath, { recursive: true, force: true }).catch(() => undefined);
  return true;
}

async function withGlobalLock<T>(operation: () => Promise<T>): Promise<T> {
  const lockPath = path.join(resolveWorkflowStateRoot(), GLOBAL_LOCK_NAME);
  await fs.mkdir(resolveWorkflowStateRoot(), { recursive: true });
  let acquired = false;
  for (let attempt = 0; attempt < GLOBAL_LOCK_ATTEMPTS; attempt += 1) {
    try {
      await fs.mkdir(lockPath);
      acquired = true;
      break;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      try {
        const stat = await fs.stat(lockPath);
        if (Date.now() - stat.mtimeMs > GLOBAL_STALE_LOCK_MS) {
          if (await recoverStaleGlobalLock(lockPath)) continue;
        }
      } catch (statError) {
        if ((statError as NodeJS.ErrnoException).code !== 'ENOENT') throw statError;
      }
      await delay(GLOBAL_LOCK_RETRY_MS);
    }
  }
  if (!acquired) throw new Error('Operational Memory global index is busy');
  try {
    return await operation();
  } finally {
    await fs.rm(lockPath, { recursive: true, force: true }).catch(() => undefined);
  }
}

interface GlobalSourceSnapshot {
  memoryPath: string;
  sourceId: string;
  projectKey: string;
  size: number;
  mtimeMs: number;
  ctimeMs: number;
}

async function listGlobalSources(): Promise<GlobalSourceSnapshot[]> {
  const stateRoot = resolveWorkflowStateRoot();
  let names: string[];
  try { names = await fs.readdir(stateRoot); } catch { return []; }
  const sources: GlobalSourceSnapshot[] = [];
  for (const name of names) {
    if (!name.endsWith('.memory.jsonl')) continue;
    const memoryPath = path.join(stateRoot, name);
    const indexPath = memoryPath.slice(0, -'.memory.jsonl'.length) + '.memory.sqlite';
    const correlation = await readOperationalMemoryIndexCorrelation(indexPath);
    if (!correlation?.projectId) continue;
    const key = projectKey(correlation);
    if (!key) continue;
    const stat = await fs.stat(memoryPath).catch(() => null);
    if (!stat?.isFile()) continue;
    sources.push({
      memoryPath,
      sourceId: sourceIdForMemoryPath(memoryPath),
      projectKey: key,
      size: stat.size,
      mtimeMs: stat.mtimeMs,
      ctimeMs: stat.ctimeMs,
    });
  }
  return sources.sort((a, b) => a.sourceId.localeCompare(b.sourceId));
}

function isEligibleGlobalLesson(event: IndexableOperationalMemoryEvent | null): event is IndexableOperationalMemoryEvent & { lessonCode: string } {
  return !!event &&
    event.kind === 'lesson' &&
    event.reasonCode === 'learned_pattern' &&
    event.sourceTool === 'project_workflow' &&
    event.family === 'workflow' &&
    isOperationalLessonCode(event.lessonCode);
}

function upsertGlobalLesson(
  db: SqliteDatabase,
  projectKeyValue: string,
  event: IndexableOperationalMemoryEvent & { lessonCode: string },
): void {
  db.prepare(`
    INSERT INTO global_project_lessons
      (project_key, fingerprint, lesson_code, first_seen_at, last_seen_at, occurrences)
    VALUES (?, ?, ?, ?, ?, 1)
    ON CONFLICT(project_key, fingerprint) DO UPDATE SET
      lesson_code = excluded.lesson_code,
      first_seen_at = CASE WHEN excluded.first_seen_at < first_seen_at THEN excluded.first_seen_at ELSE first_seen_at END,
      last_seen_at = CASE WHEN excluded.last_seen_at > last_seen_at THEN excluded.last_seen_at ELSE last_seen_at END,
      occurrences = occurrences + 1
  `).run(
    projectKeyValue,
    event.fingerprint,
    event.lessonCode,
    event.occurredAt,
    event.occurredAt,
  );
}

function writeSourceCheckpoint(db: SqliteDatabase, source: GlobalSourceSnapshot): void {
  db.prepare(`
    INSERT INTO global_sources
      (source_id, project_key, authority_size_bytes, authority_mtime_ms, authority_ctime_ms)
    VALUES (?, ?, ?, ?, ?)
    ON CONFLICT(source_id) DO UPDATE SET
      project_key = excluded.project_key,
      authority_size_bytes = excluded.authority_size_bytes,
      authority_mtime_ms = excluded.authority_mtime_ms,
      authority_ctime_ms = excluded.authority_ctime_ms
  `).run(
    source.sourceId,
    source.projectKey,
    source.size,
    source.mtimeMs,
    source.ctimeMs,
  );
}

async function ingestSource(
  db: SqliteDatabase,
  source: GlobalSourceSnapshot,
  parseLine: OperationalMemoryGlobalLineParser,
): Promise<void> {
  const input = createReadStream(source.memoryPath, { encoding: 'utf8' });
  const lines = readline.createInterface({ input, crlfDelay: Infinity });
  db.exec('BEGIN IMMEDIATE');
  try {
    for await (const line of lines) {
      const event = parseLine(line);
      if (isEligibleGlobalLesson(event)) upsertGlobalLesson(db, source.projectKey, event);
    }
    writeSourceCheckpoint(db, source);
    db.exec('COMMIT');
  } catch (error) {
    try { db.exec('ROLLBACK'); } catch { /* best effort */ }
    throw error;
  } finally {
    lines.close();
    input.destroy();
  }
}

function sameNumber(a: unknown, b: number): boolean {
  return Number(a) === b;
}

function sourcesMatch(db: SqliteDatabase, sources: GlobalSourceSnapshot[]): boolean {
  const rows = db.prepare(`
    SELECT source_id, project_key, authority_size_bytes, authority_mtime_ms, authority_ctime_ms
    FROM global_sources ORDER BY source_id ASC
  `).all();
  if (rows.length !== sources.length) return false;
  for (let index = 0; index < sources.length; index += 1) {
    const row = rows[index];
    const source = sources[index];
    if (
      String(row.source_id) !== source.sourceId ||
      String(row.project_key) !== source.projectKey ||
      !sameNumber(row.authority_size_bytes, source.size) ||
      !sameNumber(row.authority_mtime_ms, source.mtimeMs) ||
      !sameNumber(row.authority_ctime_ms, source.ctimeMs)
    ) return false;
  }
  return true;
}

function validExistingIndex(indexPath: string, sources: GlobalSourceSnapshot[]): boolean {
  const db = openDatabase(indexPath, true);
  if (!db) return false;
  try {
    validateSchema(db);
    return sourcesMatch(db, sources);
  } catch {
    return false;
  } finally {
    db.close();
  }
}

async function rebuildGlobalIndex(
  indexPath: string,
  sources: GlobalSourceSnapshot[],
  parseLine: OperationalMemoryGlobalLineParser,
): Promise<boolean> {
  const DatabaseSync = databaseConstructor();
  if (!DatabaseSync) return false;
  await fs.mkdir(path.dirname(indexPath), { recursive: true });
  const tempPath = indexPath + '.rebuild-' + process.pid + '-' + Date.now();
  await fs.rm(tempPath, { force: true }).catch(() => undefined);
  const db = new DatabaseSync(tempPath);
  let complete = false;
  try {
    initializeSchema(db);
    for (const source of sources) await ingestSource(db, source, parseLine);
    validateSchema(db);
    complete = true;
  } finally {
    db.close();
    if (!complete) await fs.rm(tempPath, { force: true }).catch(() => undefined);
  }

  const backupPath = indexPath + '.replaced-' + process.pid + '-' + Date.now();
  const existing = await fs.stat(indexPath).catch(() => null);
  let movedExisting = false;
  try {
    if (existing?.isFile()) {
      await fs.rename(indexPath, backupPath);
      movedExisting = true;
    }
    await fs.rename(tempPath, indexPath);
    if (movedExisting) await fs.rm(backupPath, { force: true }).catch(() => undefined);
    return true;
  } catch (error) {
    await fs.rm(tempPath, { force: true }).catch(() => undefined);
    if (movedExisting && !(await fs.stat(indexPath).catch(() => null))) {
      await fs.rename(backupPath, indexPath).catch(() => undefined);
    }
    throw error;
  }
}

async function ensureGlobalIndex(
  parseLine: OperationalMemoryGlobalLineParser,
): Promise<boolean> {
  if (!databaseConstructor()) return false;
  const indexPath = resolveOperationalMemoryGlobalIndexPath();
  const sources = await listGlobalSources();
  const existing = await fs.stat(indexPath).catch(() => null);
  if (existing?.isFile() && validExistingIndex(indexPath, sources)) return true;
  if (existing && !existing.isFile()) return false;

  return withGlobalLock(async () => {
    const refreshedSources = await listGlobalSources();
    const refreshed = await fs.stat(indexPath).catch(() => null);
    if (refreshed?.isFile() && validExistingIndex(indexPath, refreshedSources)) return true;
    try {
      return await rebuildGlobalIndex(indexPath, refreshedSources, parseLine);
    } catch {
      return false;
    }
  });
}

function sourceCheckpointMatchesBeforeAppend(
  db: SqliteDatabase,
  sourceId: string,
  projectKeyValue: string,
  before: { size: number; mtimeMs: number; ctimeMs: number },
): boolean {
  const row = db.prepare(`
    SELECT project_key, authority_size_bytes, authority_mtime_ms, authority_ctime_ms
    FROM global_sources WHERE source_id = ?
  `).get(sourceId);
  return !!row &&
    String(row.project_key) === projectKeyValue &&
    sameNumber(row.authority_size_bytes, before.size) &&
    sameNumber(row.authority_mtime_ms, before.mtimeMs) &&
    sameNumber(row.authority_ctime_ms, before.ctimeMs);
}

export async function updateOperationalMemoryGlobalIndexAfterAppend(
  memoryPath: string,
  event: IndexableOperationalMemoryEvent,
  scope: OperationalMemoryScopeCorrelation | undefined,
  authorityBeforeAppend: { size: number; mtimeMs: number; ctimeMs: number },
): Promise<boolean> {
  const key = scope ? projectKey(scope) : null;
  if (!key) return false;
  const indexPath = resolveOperationalMemoryGlobalIndexPath();
  const existing = await fs.stat(indexPath).catch(() => null);
  if (!existing?.isFile()) return false;

  return withGlobalLock(async () => {
    const db = openDatabase(indexPath);
    if (!db) return false;
    try {
      validateSchema(db);
      const sourceId = sourceIdForMemoryPath(memoryPath);
      if (!sourceCheckpointMatchesBeforeAppend(db, sourceId, key, authorityBeforeAppend)) return false;
      const stat = await fs.stat(memoryPath).catch(() => null);
      if (!stat?.isFile()) return false;
      const source: GlobalSourceSnapshot = {
        memoryPath,
        sourceId,
        projectKey: key,
        size: stat.size,
        mtimeMs: stat.mtimeMs,
        ctimeMs: stat.ctimeMs,
      };
      db.exec('BEGIN IMMEDIATE');
      try {
        if (isEligibleGlobalLesson(event)) upsertGlobalLesson(db, key, event);
        writeSourceCheckpoint(db, source);
        db.exec('COMMIT');
        return true;
      } catch (error) {
        try { db.exec('ROLLBACK'); } catch { /* best effort */ }
        throw error;
      }
    } catch {
      return false;
    } finally {
      db.close();
    }
  });
}

export async function readOperationalMemoryGlobalGroups(
  currentScope: OperationalMemoryScopeCorrelation,
  parseLine: OperationalMemoryGlobalLineParser,
): Promise<IndexedOperationalMemoryGlobalGroup[]> {
  const currentKey = projectKey(currentScope);
  if (!currentKey || !await ensureGlobalIndex(parseLine)) return [];
  const db = openDatabase(resolveOperationalMemoryGlobalIndexPath(), true);
  if (!db) return [];
  try {
    validateSchema(db);
    const rows = db.prepare(`
      SELECT fingerprint, lesson_code,
        MIN(first_seen_at) AS first_seen_at,
        MAX(last_seen_at) AS last_seen_at,
        SUM(occurrences) AS occurrences,
        COUNT(*) AS distinct_projects
      FROM global_project_lessons
      WHERE project_key <> ?
      GROUP BY fingerprint, lesson_code
      ORDER BY last_seen_at DESC
    `).all(currentKey);
    return rows.flatMap((row) => {
      const lessonCode = String(row.lesson_code);
      if (!isOperationalLessonCode(lessonCode)) return [];
      return [{
        fingerprint: String(row.fingerprint),
        lessonCode,
        firstSeenAt: String(row.first_seen_at),
        lastSeenAt: String(row.last_seen_at),
        occurrences: Number(row.occurrences),
        distinctProjects: Number(row.distinct_projects),
      }];
    });
  } catch {
    return [];
  } finally {
    db.close();
  }
}