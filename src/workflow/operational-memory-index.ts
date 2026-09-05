import crypto from 'node:crypto';
import { createRequire } from 'node:module';
import fs from 'node:fs/promises';
import path from 'node:path';

const INDEX_SCHEMA_VERSION = 3;
const READ_CHUNK_BYTES = 256 * 1024;
const EMPTY_AUTHORITY_CHAIN = crypto.createHash('sha256').update('operational-memory-authority-v1').digest('hex');
const runtimeRequire = createRequire(import.meta.url);

export interface IndexableOperationalMemoryEvent {
  id: string;
  workflowId: string;
  kind: string;
  reasonCode: string;
  sourceTool: string;
  family: string;
  stageId?: string;
  lessonCode?: string;
  fingerprint: string;
  occurredAt: string;
}

export interface IndexedOperationalMemoryEvent extends IndexableOperationalMemoryEvent {
  recordSequence: number;
  startOffset: number;
}

export interface OperationalMemoryScopeCorrelation {
  projectId?: string;
  repositoryId?: string;
}

export type OperationalMemoryLineParser = (
  line: string,
) => IndexableOperationalMemoryEvent | null;
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
  DatabaseSync?: new (location: string) => SqliteDatabase;
}

type DatabaseConstructor = NonNullable<SqliteModule['DatabaseSync']>;
let cachedDatabaseConstructor: DatabaseConstructor | null | undefined;

function databaseConstructor(): DatabaseConstructor | null {
  if (cachedDatabaseConstructor !== undefined) return cachedDatabaseConstructor;
  try {
    const moduleName = ['node', 'sqlite'].join(':');
    const sqlite = runtimeRequire(moduleName) as SqliteModule;
    cachedDatabaseConstructor = sqlite.DatabaseSync ?? null;
  } catch {
    cachedDatabaseConstructor = null;
  }
  return cachedDatabaseConstructor;
}
function createSchema(db: SqliteDatabase): void {
  db.exec(`
    PRAGMA busy_timeout = 1500;
    CREATE TABLE IF NOT EXISTS events (
      record_sequence INTEGER PRIMARY KEY,
      start_offset INTEGER NOT NULL,
      end_offset INTEGER NOT NULL,
      workflow_id TEXT NOT NULL,
      kind TEXT NOT NULL,
      reason_code TEXT NOT NULL,
      lesson_code TEXT,
      source_tool TEXT NOT NULL,
      family TEXT NOT NULL,
      stage_id TEXT,
      fingerprint TEXT NOT NULL,
      occurred_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS events_workflow_sequence
      ON events(workflow_id, record_sequence);
    CREATE INDEX IF NOT EXISTS events_workflow_fingerprint
      ON events(workflow_id, fingerprint);
  `);
}
function createAggregateSchema(db: SqliteDatabase): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS groups (
      workflow_id TEXT NOT NULL,
      fingerprint TEXT NOT NULL,
      kind TEXT NOT NULL,
      reason_code TEXT NOT NULL,
      lesson_code TEXT,
      source_tool TEXT NOT NULL,
      family TEXT NOT NULL,
      stage_id TEXT,
      first_seen_at TEXT NOT NULL,
      last_seen_at TEXT NOT NULL,
      occurrences INTEGER NOT NULL,
      latest_record_sequence INTEGER NOT NULL,
      PRIMARY KEY (workflow_id, fingerprint)
    );
    CREATE TABLE IF NOT EXISTS index_state (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      schema_version INTEGER NOT NULL,
      indexed_through_offset INTEGER NOT NULL,
      authority_size_bytes INTEGER NOT NULL,
      authority_mtime_ms REAL NOT NULL,
      authority_ctime_ms REAL NOT NULL,
      record_count INTEGER NOT NULL,
      project_id TEXT,
      repository_id TEXT,
      authority_chain_hash TEXT NOT NULL,
      rebuild_status TEXT NOT NULL
    );
  `);
}
function initializeSchema(db: SqliteDatabase): void {
  createSchema(db);
  createAggregateSchema(db);
}

interface IndexState {
  schemaVersion: number;
  indexedThroughOffset: number;
  authoritySizeBytes: number;
  authorityMtimeMs: number;
  authorityCtimeMs: number;
  recordCount: number;
  projectId?: string;
  repositoryId?: string;
  authorityChainHash: string;
}

function readIndexState(db: SqliteDatabase): IndexState | null {
  const row = db.prepare(
    'SELECT schema_version, indexed_through_offset, authority_size_bytes, authority_mtime_ms, authority_ctime_ms, record_count, project_id, repository_id, authority_chain_hash FROM index_state WHERE id = 1',
  ).get();
  if (!row) return null;
  return {
    schemaVersion: Number(row.schema_version),
    indexedThroughOffset: Number(row.indexed_through_offset),
    authoritySizeBytes: Number(row.authority_size_bytes),
    authorityMtimeMs: Number(row.authority_mtime_ms),
    authorityCtimeMs: Number(row.authority_ctime_ms),
    recordCount: Number(row.record_count),
    ...(textOrUndefined(row.project_id) ? { projectId: String(row.project_id) } : {}),
    ...(textOrUndefined(row.repository_id) ? { repositoryId: String(row.repository_id) } : {}),
    authorityChainHash: String(row.authority_chain_hash),
  };
}

function validateSchema(db: SqliteDatabase): void {
  const requiredEventColumns = new Set([
    'record_sequence', 'start_offset', 'end_offset', 'workflow_id',
    'kind', 'reason_code', 'source_tool', 'family', 'fingerprint', 'occurred_at',
  ]);
  const eventColumns = new Set(
    db.prepare('PRAGMA table_info(events)').all().map((row) => String(row.name)),
  );
  for (const column of requiredEventColumns) {
    if (!eventColumns.has(column)) throw new Error('Operational memory index schema is incompatible');
  }
  const groupColumns = new Set(
    db.prepare('PRAGMA table_info(groups)').all().map((row) => String(row.name)),
  );
  for (const column of ['workflow_id', 'fingerprint', 'occurrences', 'latest_record_sequence']) {
    if (!groupColumns.has(column)) throw new Error('Operational memory group schema is incompatible');
  }
  const stateColumns = new Set(
    db.prepare('PRAGMA table_info(index_state)').all().map((row) => String(row.name)),
  );
  for (const column of [
    'schema_version', 'indexed_through_offset', 'authority_size_bytes',
    'authority_mtime_ms', 'authority_ctime_ms', 'record_count', 'project_id', 'repository_id',
    'authority_chain_hash', 'rebuild_status',
  ]) {
    if (!stateColumns.has(column)) throw new Error('Operational memory index-state schema is incompatible');
  }
  const state = readIndexState(db);
  if (state && state.schemaVersion !== INDEX_SCHEMA_VERSION) {
    throw new Error('Operational memory index schema version is incompatible');
  }
}

interface JournalRecord {
  line: string;
  startOffset: number;
  endOffset: number;
}
async function* readJournalRecords(
  memoryPath: string,
  startOffset: number,
  endOffset: number,
): AsyncGenerator<JournalRecord> {
  if (endOffset <= startOffset) return;
  const handle = await fs.open(memoryPath, 'r');
  let readPosition = startOffset;
  let pending = Buffer.alloc(0);
  let pendingStart = startOffset;
  try {
    while (readPosition < endOffset) {
      const requested = Math.min(READ_CHUNK_BYTES, endOffset - readPosition);
      const chunk = Buffer.alloc(requested);
      const { bytesRead } = await handle.read(chunk, 0, requested, readPosition);
      if (bytesRead <= 0) break;
      const current = chunk.subarray(0, bytesRead);
      const combinedBase = pending.length > 0 ? pendingStart : readPosition;
      const combined = pending.length > 0 ? Buffer.concat([pending, current]) : current;
      let cursor = 0;
      let newline = combined.indexOf(0x0a, cursor);
      while (newline >= 0) {
        const raw = combined.subarray(cursor, newline);
        const line = raw.length > 0 && raw[raw.length - 1] === 0x0d ? raw.subarray(0, -1) : raw;
        if (line.length > 0) {
          yield { line: line.toString('utf8'), startOffset: combinedBase + cursor, endOffset: combinedBase + newline + 1 };
        }
        cursor = newline + 1;
        newline = combined.indexOf(0x0a, cursor);
      }
      pending = combined.subarray(cursor);
      pendingStart = combinedBase + cursor;
      readPosition += bytesRead;
    }
  } finally {
    await handle.close();
  }
}

function extendAuthorityChain(current: string, line: string): string {
  const lineHash = crypto.createHash('sha256').update(line, 'utf8').digest('hex');
  return crypto.createHash('sha256').update(current + ':' + lineHash).digest('hex');
}

async function computeAuthorityChain(memoryPath: string, endOffset: number): Promise<string> {
  let chain = EMPTY_AUTHORITY_CHAIN;
  for await (const record of readJournalRecords(memoryPath, 0, endOffset)) {
    chain = extendAuthorityChain(chain, record.line);
  }
  return chain;
}

function insertEvent(
  db: SqliteDatabase,
  event: IndexableOperationalMemoryEvent,
  recordSequence: number,
  record: JournalRecord,
): void {
  db.prepare(`
    INSERT INTO events (
      record_sequence, start_offset, end_offset, workflow_id, kind,
      reason_code, lesson_code, source_tool, family, stage_id, fingerprint, occurred_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    recordSequence, record.startOffset, record.endOffset, event.workflowId,
    event.kind, event.reasonCode, event.lessonCode ?? null, event.sourceTool,
    event.family, event.stageId ?? null, event.fingerprint, event.occurredAt,
  );
}
function updateGroup(
  db: SqliteDatabase,
  event: IndexableOperationalMemoryEvent,
  recordSequence: number,
): void {
  db.prepare(`
    INSERT INTO groups (
      workflow_id, fingerprint, kind, reason_code, lesson_code, source_tool,
      family, stage_id, first_seen_at, last_seen_at, occurrences,
      latest_record_sequence
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?)
    ON CONFLICT(workflow_id, fingerprint) DO UPDATE SET
      kind = excluded.kind,
      reason_code = excluded.reason_code,
      lesson_code = excluded.lesson_code,
      source_tool = excluded.source_tool,
      family = excluded.family,
      stage_id = excluded.stage_id,
      last_seen_at = excluded.last_seen_at,
      occurrences = groups.occurrences + 1,
      latest_record_sequence = excluded.latest_record_sequence
  `).run(
    event.workflowId, event.fingerprint, event.kind, event.reasonCode,
    event.lessonCode ?? null, event.sourceTool, event.family, event.stageId ?? null,
    event.occurredAt, event.occurredAt, recordSequence,
  );
}
function writeIndexState(
  db: SqliteDatabase,
  indexedThroughOffset: number,
  authoritySizeBytes: number,
  authorityMtimeMs: number,
  authorityCtimeMs: number,
  recordCount: number,
  scope: OperationalMemoryScopeCorrelation | undefined,
  authorityChainHash: string,
): void {
  db.prepare(`
    INSERT INTO index_state (
      id, schema_version, indexed_through_offset, authority_size_bytes,
      authority_mtime_ms, authority_ctime_ms, record_count, project_id, repository_id,
      authority_chain_hash, rebuild_status
    ) VALUES (1, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'ready')
    ON CONFLICT(id) DO UPDATE SET
      schema_version = excluded.schema_version,
      indexed_through_offset = excluded.indexed_through_offset,
      authority_size_bytes = excluded.authority_size_bytes,
      authority_mtime_ms = excluded.authority_mtime_ms,
      authority_ctime_ms = excluded.authority_ctime_ms,
      record_count = excluded.record_count,
      project_id = excluded.project_id,
      repository_id = excluded.repository_id,
      authority_chain_hash = excluded.authority_chain_hash,
      rebuild_status = excluded.rebuild_status
  `).run(
    INDEX_SCHEMA_VERSION,
    indexedThroughOffset,
    authoritySizeBytes,
    authorityMtimeMs,
    authorityCtimeMs,
    recordCount,
    scope?.projectId ?? null,
    scope?.repositoryId ?? null,
    authorityChainHash,
  );
}

async function journalStat(memoryPath: string): Promise<{ size: number; mtimeMs: number; ctimeMs: number }> {
  const stat = await fs.stat(memoryPath).catch((error) => {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  });
  return stat ? { size: stat.size, mtimeMs: stat.mtimeMs, ctimeMs: stat.ctimeMs } : { size: 0, mtimeMs: 0, ctimeMs: 0 };
}
async function ingestRange(
  db: SqliteDatabase,
  memoryPath: string,
  startOffset: number,
  endOffset: number,
  initialRecordCount: number,
  initialAuthorityChainHash: string,
  parseLine: OperationalMemoryLineParser,
  authorityMtimeMs: number,
  authorityCtimeMs: number,
  scope: OperationalMemoryScopeCorrelation | undefined,
): Promise<number> {
  let recordCount = initialRecordCount;
  let indexedThroughOffset = startOffset;
  let authorityChainHash = initialAuthorityChainHash;
  db.exec('BEGIN IMMEDIATE');
  try {
    for await (const record of readJournalRecords(memoryPath, startOffset, endOffset)) {
      indexedThroughOffset = record.endOffset;
      recordCount += 1;
      authorityChainHash = extendAuthorityChain(authorityChainHash, record.line);
      let event: IndexableOperationalMemoryEvent | null = null;
      try {
        event = parseLine(record.line);
      } catch {
        event = null;
      }
      if (event) {
        insertEvent(db, event, recordCount, record);
        updateGroup(db, event, recordCount);
      }
    }
    writeIndexState(
      db, indexedThroughOffset, endOffset, authorityMtimeMs, authorityCtimeMs, recordCount,
      scope, authorityChainHash,
    );
    db.exec('COMMIT');
    return recordCount;
  } catch (error) {
    try { db.exec('ROLLBACK'); } catch { /* best effort */ }
    throw error;
  }
}
function openDatabase(indexPath: string): SqliteDatabase | null {
  const DatabaseSync = databaseConstructor();
  if (!DatabaseSync) return null;
  try {
    return new DatabaseSync(indexPath);
  } catch {
    return null;
  }
}

async function rebuildIndex(
  memoryPath: string,
  indexPath: string,
  parseLine: OperationalMemoryLineParser,
  scope?: OperationalMemoryScopeCorrelation,
): Promise<boolean> {
  const DatabaseSync = databaseConstructor();
  if (!DatabaseSync) return false;
  const existing = await fs.stat(indexPath).catch((error) => {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  });
  if (existing?.isDirectory()) return false;

  await fs.mkdir(path.dirname(indexPath), { recursive: true });
  const tempPath = indexPath + '.rebuild-' + process.pid + '-' + Date.now();
  await fs.rm(tempPath, { force: true }).catch(() => undefined);
  const db = new DatabaseSync(tempPath);
  let buildComplete = false;
  try {
    initializeSchema(db);
    const stat = await journalStat(memoryPath);
    if (stat.size > 0) {
      await ingestRange(
        db, memoryPath, 0, stat.size, 0, EMPTY_AUTHORITY_CHAIN,
        parseLine, stat.mtimeMs, stat.ctimeMs, scope,
      );
    } else {
      writeIndexState(db, 0, 0, 0, 0, 0, scope, EMPTY_AUTHORITY_CHAIN);
    }
    validateSchema(db);
    buildComplete = true;
  } finally {
    db.close();
    if (!buildComplete) {
      await fs.rm(tempPath, { force: true }).catch(() => undefined);
    }
  }
  const backupPath = indexPath + '.replaced-' + process.pid + '-' + Date.now();
  let movedExisting = false;
  try {
    if (existing) {
      await fs.rename(indexPath, backupPath);
      movedExisting = true;
    }
    await fs.rename(tempPath, indexPath);
    if (movedExisting) {
      await fs.rm(backupPath, { force: true }).catch(() => undefined);
    }
    return true;
  } catch (error) {
    await fs.rm(tempPath, { force: true }).catch(() => undefined);
    if (movedExisting) {
      const replacementExists = await fs.stat(indexPath).then(() => true, () => false);
      if (!replacementExists) {
        await fs.rename(backupPath, indexPath).catch(() => undefined);
      }
    }
    throw error;
  }
}

async function synchronizeExistingIndex(
  memoryPath: string,
  indexPath: string,
  parseLine: OperationalMemoryLineParser,
  scope?: OperationalMemoryScopeCorrelation,
  authorityBeforeAppend?: { size: number; mtimeMs: number; ctimeMs: number },
): Promise<boolean> {
  const db = openDatabase(indexPath);
  if (!db) return false;
  try {
    initializeSchema(db);
    validateSchema(db);
    const state = readIndexState(db);
    if (!state) return false;
    if (scope?.projectId && state.projectId !== scope.projectId) return false;
    if (scope?.repositoryId && state.repositoryId !== scope.repositoryId) return false;
    const stat = await journalStat(memoryPath);
    if (stat.size < state.indexedThroughOffset) return false;
    const metadataUnchanged =
      stat.size === state.authoritySizeBytes &&
      stat.mtimeMs === state.authorityMtimeMs &&
      stat.ctimeMs === state.authorityCtimeMs;
    if (metadataUnchanged) return true;
    const trustedAppendOnlyGrowth = !!authorityBeforeAppend &&
      state.authoritySizeBytes === authorityBeforeAppend.size &&
      state.authorityMtimeMs === authorityBeforeAppend.mtimeMs &&
      state.authorityCtimeMs === authorityBeforeAppend.ctimeMs;
    if (!trustedAppendOnlyGrowth) {
      const currentChain = await computeAuthorityChain(memoryPath, state.indexedThroughOffset);
      if (currentChain !== state.authorityChainHash) return false;
    }
    if (stat.size === state.indexedThroughOffset) {
      writeIndexState(
        db, state.indexedThroughOffset, stat.size, stat.mtimeMs, stat.ctimeMs, state.recordCount,
        scope, state.authorityChainHash,
      );
      return true;
    }

    await ingestRange(
      db,
      memoryPath,
      state.indexedThroughOffset,
      stat.size,
      state.recordCount,
      state.authorityChainHash,
      parseLine,
      stat.mtimeMs,
      stat.ctimeMs,
      scope,
    );
    return true;
  } catch {
    return false;
  } finally {
    db.close();
  }
}

export async function updateOperationalMemoryIndexAfterAppend(
  memoryPath: string,
  indexPath: string,
  parseLine: OperationalMemoryLineParser,
  scope?: OperationalMemoryScopeCorrelation,
  authorityBeforeAppend?: { size: number; mtimeMs: number; ctimeMs: number },
): Promise<boolean> {
  const stat = await fs.stat(indexPath).catch(() => null);
  if (!stat?.isFile()) return false;
  return synchronizeExistingIndex(
    memoryPath, indexPath, parseLine, scope, authorityBeforeAppend,
  );
}
export async function ensureOperationalMemoryIndex(
  memoryPath: string,
  indexPath: string,
  parseLine: OperationalMemoryLineParser,
  scope?: OperationalMemoryScopeCorrelation,
): Promise<boolean> {
  if (!databaseConstructor()) return false;
  const existing = await fs.stat(indexPath).catch(() => null);
  if (existing?.isFile()) {
    const synchronized = await synchronizeExistingIndex(memoryPath, indexPath, parseLine, scope);
    if (synchronized) return true;
  } else if (existing) {
    return false;
  }
  try {
    return await rebuildIndex(memoryPath, indexPath, parseLine, scope);
  } catch {
    return false;
  }
}

function textOrUndefined(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

export async function readOperationalMemoryIndexEvents(
  memoryPath: string,
  indexPath: string,
  workflowId: string,
  maxTailBytes: number,
  maxRecords: number,
  parseLine: OperationalMemoryLineParser,
  scope?: OperationalMemoryScopeCorrelation,
): Promise<IndexedOperationalMemoryEvent[] | null> {
  if (!await ensureOperationalMemoryIndex(memoryPath, indexPath, parseLine, scope)) return null;
  const db = openDatabase(indexPath);
  if (!db) return null;
  try {
    validateSchema(db);
    const state = readIndexState(db);
    if (!state || state.schemaVersion !== INDEX_SCHEMA_VERSION) return null;
    const tailCutoff = Math.max(0, state.authoritySizeBytes - maxTailBytes);
    const minimumStartOffset = tailCutoff === 0 ? 0 : tailCutoff + 1;
    const minimumSequence = Math.max(1, state.recordCount - maxRecords + 1);
    const rows = db.prepare(`
      SELECT record_sequence, start_offset, workflow_id, kind,
        reason_code, lesson_code, source_tool, family, stage_id, fingerprint, occurred_at
      FROM events
      WHERE workflow_id = ? AND record_sequence >= ? AND start_offset >= ?
      ORDER BY record_sequence ASC
    `).all(workflowId, minimumSequence, minimumStartOffset);

    return rows.map((row) => ({
      recordSequence: Number(row.record_sequence),
      startOffset: Number(row.start_offset),
      id: `indexed-event-${Number(row.record_sequence)}`,
      workflowId: String(row.workflow_id),
      kind: String(row.kind),
      reasonCode: String(row.reason_code),
      sourceTool: String(row.source_tool),
      family: String(row.family),
      ...(textOrUndefined(row.stage_id) ? { stageId: String(row.stage_id) } : {}),
      ...(textOrUndefined(row.lesson_code) ? { lessonCode: String(row.lesson_code) } : {}),
      fingerprint: String(row.fingerprint),
      occurredAt: String(row.occurred_at),
    }));
  } catch {
    return null;
  } finally {
    db.close();
  }
}
