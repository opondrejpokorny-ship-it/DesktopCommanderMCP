import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import type { ServerResult } from '../types.js';
import {
  isOperationalLessonCode,
  OPERATIONAL_LESSON_TEMPLATES,
  type OperationalLessonCode,
} from './operational-memory-contract.js';
import {
  resolveWorkflowMemoryIndexPath,
  resolveWorkflowMemoryPath,
  resolveWorkflowStatePath,
  resolveWorkflowStateRoot,
  workflowProjectIdentity,
} from './workflow-storage.js';
import { resolveProjectIdentity } from './scope-identity.js';
import {
  readOperationalMemoryIndexCorrelation,
  readOperationalMemoryIndexEvents,
  readOperationalMemoryProjectGroups,
  type IndexedOperationalMemoryProjectGroup,
  type OperationalMemoryScopeCorrelation,
  updateOperationalMemoryIndexAfterAppend,
} from './operational-memory-index.js';
import {
  readOperationalMemoryGlobalGroups,
  updateOperationalMemoryGlobalIndexAfterAppend,
} from './operational-memory-global-index.js';

export type OperationalMemoryKind = 'error' | 'limit' | 'lesson';
export type OperationalReasonCode =
  | 'approval_required'
  | 'policy_denied'
  | 'not_found'
  | 'permission_denied'
  | 'timeout'
  | 'unsupported'
  | 'validation_error'
  | 'process_exit_nonzero'
  | 'process_wait_timeout'
  | 'learned_pattern'
  | 'tool_error';

export interface OperationalMemoryEvent {
  version: 1;
  id: string;
  workflowId: string;
  taskId?: string;
  runId?: string;
  kind: OperationalMemoryKind;
  reasonCode: OperationalReasonCode;
  sourceTool: string;
  family: string;
  stageId?: string;
  lessonCode?: OperationalLessonCode;
  summary: string;
  lesson: string;
  fingerprint: string;
  occurredAt: string;
}

export type OperationalMemoryScope = 'workflow' | 'project' | 'global';
export type OperationalMemoryRelevanceReason =
  | 'current_run_exact_stage'
  | 'current_run_family_match'
  | 'current_run_recent'
  | 'current_task_history'
  | 'project_exact_stage'
  | 'project_family_match'
  | 'project_repeated'
  | 'project_recent'
  | 'global_repeated'
  | 'global_recent';

export interface OperationalMemoryLesson {
  fingerprint: string;
  kind: OperationalMemoryKind;
  reasonCode: OperationalReasonCode;
  sourceTool: string;
  family: string;
  stageId?: string;
  lessonCode?: OperationalLessonCode;
  summary: string;
  lesson: string;
  occurrences: number;
  firstSeenAt: string;
  lastSeenAt: string;
  relevanceScore: number;
  scope: OperationalMemoryScope;
  relevanceReason: OperationalMemoryRelevanceReason;
}

export interface OperationalMemoryScopeContext {
  taskId: string;
  runId?: string;
}

export interface OperationalMemorySummary {
  totalEvents: number;
  uniqueLessons: number;
  lessons: OperationalMemoryLesson[];
}
interface PersistedWorkflowState {
  version: 1 | 2;
  workflowId: string;
  taskId?: string;
  runId?: string;
  projectRoot: string;
  completedAt?: string;
  profile: { stages: Array<{ id: string }> };
  stages: Record<string, { status: string }>;
}

export interface RecordOperationalToolFailureInput {
  tool: string;
  args?: unknown;
  result: ServerResult;
  policyDecision?: 'deny' | 'require_approval';
  observedReasonCode?: 'process_exit_nonzero' | 'process_wait_timeout';
}

export interface RecordOperationalLessonInput {
  projectRoot: string;
  lessonCode: OperationalLessonCode;
}

const MAX_MEMORY_TAIL_BYTES = 512 * 1024;
const MAX_MEMORY_EVENTS = 1000;
const MAX_RELEVANT_LESSONS = 8;
const MEMORY_LOCK_RETRY_MS = 25;
const MEMORY_LOCK_ATTEMPTS = 200;
const MEMORY_STALE_LOCK_MS = 30_000;
const memoryWriteChains = new Map<string, Promise<void>>();

function safeToolName(value: string): string {
  const normalized = String(value).trim().slice(0, 80);
  return /^[a-z0-9_.-]+$/i.test(normalized) ? normalized : 'unknown_tool';
}

function familyForTool(tool: string): string {
  if (/^(read_file|read_multiple_files|list_directory|get_file_info)$/.test(tool)) {
    return 'filesystem.read';
  }
  if (/^(write_file|write_pdf|edit_block|create_directory|move_file)$/.test(tool)) {
    return 'filesystem.write';
  }
  if (/^(start_process|read_process_output|interact_with_process)$/.test(tool)) {
    return 'terminal';
  }
  if (/^(kill_process|force_terminate|list_processes|list_sessions)$/.test(tool)) {
    return 'process';
  }
  if (tool === 'project_workflow') return 'workflow';
  if (/search/.test(tool)) return 'search';
  if (/config/.test(tool)) return 'config';
  return 'other';
}

function resultText(result: ServerResult): string {
  return result.content
    .map((item) => typeof item.text === 'string' ? item.text : '')
    .join(' ')
    .toLowerCase();
}

function classifyFailure(
  result: ServerResult,
  policyDecision?: 'deny' | 'require_approval',
  observedReasonCode?: 'process_exit_nonzero' | 'process_wait_timeout',
): { kind: OperationalMemoryKind; reasonCode: OperationalReasonCode } {
  if (observedReasonCode === 'process_exit_nonzero') {
    return { kind: 'error', reasonCode: 'process_exit_nonzero' };
  }
  if (observedReasonCode === 'process_wait_timeout') {
    return { kind: 'limit', reasonCode: 'process_wait_timeout' };
  }
  if (policyDecision === 'require_approval') {
    return { kind: 'limit', reasonCode: 'approval_required' };
  }
  if (policyDecision === 'deny') {
    return { kind: 'limit', reasonCode: 'policy_denied' };
  }
  const text = resultText(result);
  if (/\b(enoent|not found|does not exist|no such file)\b/.test(text)) {
    return { kind: 'error', reasonCode: 'not_found' };
  }
  if (/\b(eacces|eperm|permission denied|access denied)\b/.test(text)) {
    return { kind: 'limit', reasonCode: 'permission_denied' };
  }
  if (/\b(timeout|timed out)\b/.test(text)) {
    return { kind: 'limit', reasonCode: 'timeout' };
  }
  if (/\b(unsupported|not supported)\b/.test(text)) {
    return { kind: 'limit', reasonCode: 'unsupported' };
  }
  if (/\b(invalid|validation|expected|required)\b/.test(text)) {
    return { kind: 'error', reasonCode: 'validation_error' };
  }
  if (/\b(blocked|denied|not allowed)\b/.test(text)) {
    return { kind: 'limit', reasonCode: 'policy_denied' };
  }
  return { kind: 'error', reasonCode: 'tool_error' };
}

function summaryFor(
  tool: string,
  code: OperationalReasonCode,
  lessonCode?: OperationalLessonCode,
): string {
  if (code === 'learned_pattern' && lessonCode) {
    return OPERATIONAL_LESSON_TEMPLATES[lessonCode].summary;
  }
  const prefix = safeToolName(tool);
  switch (code) {
    case 'approval_required':
      return prefix + ' stopped because human approval is required.';
    case 'policy_denied':
      return prefix + ' was blocked by policy.';
    case 'not_found':
      return prefix + ' failed because the requested resource was not found.';
    case 'permission_denied':
      return prefix + ' failed because the operating system denied access.';
    case 'timeout':
      return prefix + ' failed because the operation timed out.';
    case 'unsupported':
      return prefix + ' failed because the operation is unsupported.';
    case 'validation_error':
      return prefix + ' failed because its arguments were rejected.';
    case 'process_exit_nonzero':
      return prefix + ' observed a process that completed with a non-zero exit code.';
    case 'process_wait_timeout':
      return prefix + ' reached its wait timeout while the process remained active.';
    default:
      return prefix + ' failed during the previous attempt.';
  }
}

function lessonFor(
  code: OperationalReasonCode,
  lessonCode?: OperationalLessonCode,
): string {
  if (code === 'learned_pattern' && lessonCode) {
    return OPERATIONAL_LESSON_TEMPLATES[lessonCode].lesson;
  }
  switch (code) {
    case 'approval_required':
      return 'Do not retry the same protected action until a matching human approval exists.';
    case 'policy_denied':
      return 'Do not bypass or repeatedly retry a policy-blocked action; choose an allowed action or ask for an explicit policy change.';
    case 'not_found':
      return 'Re-check the resource path and current state before retrying.';
    case 'permission_denied':
      return 'Verify permissions or choose an accessible resource before retrying.';
    case 'timeout':
      return 'Check process state or reduce the operation scope before retrying.';
    case 'unsupported':
      return 'Use a supported alternative instead of repeating the unsupported operation.';
    case 'validation_error':
      return 'Correct the rejected arguments before retrying the operation.';
    case 'process_exit_nonzero':
      return 'Inspect the completed process exit evidence before retrying or changing the command.';
    case 'process_wait_timeout':
      return 'A tool wait timeout does not prove the process or test failed; inspect process completion and exit evidence.';
    default:
      return 'Inspect current state and avoid repeating the identical failed call unchanged.';
  }
}

function fingerprintFor(
  kind: OperationalMemoryKind,
  tool: string,
  reasonCode: OperationalReasonCode,
  family: string,
  lessonCode?: OperationalLessonCode,
): string {
  return crypto
    .createHash('sha256')
    .update([kind, safeToolName(tool), reasonCode, family, lessonCode ?? ''].join('|'))
    .digest('hex')
    .slice(0, 24);
}

function isWithin(candidate: string, root: string): boolean {
  const normalizedCandidate = workflowProjectIdentity(candidate);
  const normalizedRoot = workflowProjectIdentity(root);
  const relative = path.relative(normalizedRoot, normalizedCandidate);
  return relative === '' || (
    relative !== '..' &&
    !relative.startsWith('..' + path.sep) &&
    !path.isAbsolute(relative)
  );
}

function candidatePaths(args: unknown): string[] {
  const candidates: string[] = [];
  const add = (value: unknown) => {
    if (typeof value === 'string' && path.isAbsolute(value)) {
      candidates.push(path.resolve(value));
    }
  };

  if (!args || typeof args !== 'object' || Array.isArray(args)) return candidates;

  const record = args as Record<string, unknown>;
  for (const key of ['path', 'file_path', 'filePath', 'source', 'destination', 'outputPath']) {
    add(record[key]);
  }
  if (Array.isArray(record.paths)) {
    for (const value of record.paths) add(value);
  }
  return [...new Set(candidates)];
}

function parseWorkflowState(value: unknown): PersistedWorkflowState | null {
  if (!value || typeof value !== 'object') return null;
  const raw = value as Record<string, unknown>;
  if (
    (raw.version !== 1 && raw.version !== 2) ||
    typeof raw.workflowId !== 'string' || !isWorkflowId(raw.workflowId) ||
    typeof raw.projectRoot !== 'string' ||
    !raw.profile ||
    typeof raw.profile !== 'object' ||
    !raw.stages ||
    typeof raw.stages !== 'object'
  ) return null;

  if (raw.version === 1 && (raw.taskId !== undefined || raw.runId !== undefined)) return null;
  if (raw.version === 2 && (
    typeof raw.taskId !== 'string' || !isWorkflowId(raw.taskId) ||
    typeof raw.runId !== 'string' || !isWorkflowId(raw.runId) ||
    raw.taskId !== raw.workflowId
  )) return null;

  const profile = raw.profile as Record<string, unknown>;
  if (!Array.isArray(profile.stages)) return null;
  const stages = profile.stages
    .filter((item) => item && typeof item === 'object' && typeof (item as any).id === 'string')
    .map((item) => ({ id: String((item as any).id) }));

  return {
    version: raw.version,
    workflowId: raw.workflowId,
    ...(raw.version === 2 ? { taskId: String(raw.taskId), runId: String(raw.runId) } : {}),
    projectRoot: raw.projectRoot,
    ...(typeof raw.completedAt === 'string' ? { completedAt: raw.completedAt } : {}),
    profile: { stages },
    stages: raw.stages as Record<string, { status: string }>,
  };
}

function nextStageId(state: PersistedWorkflowState): string | undefined {
  return state.profile.stages.find((stage) => {
    const status = state.stages[stage.id]?.status;
    return status === 'pending' || status === 'blocked';
  })?.id;
}
async function activeWorkflowForPaths(pathsToMatch: string[]): Promise<PersistedWorkflowState | null> {
  let entries: string[];
  try {
    entries = await fs.readdir(resolveWorkflowStateRoot());
  } catch {
    return null;
  }

  const active: PersistedWorkflowState[] = [];
  for (const name of entries) {
    if (!name.endsWith('.json')) continue;
    try {
      const parsed = parseWorkflowState(JSON.parse(
        await fs.readFile(path.join(resolveWorkflowStateRoot(), name), 'utf8'),
      ));
      if (parsed && !parsed.completedAt) {
        const stat = await fs.stat(parsed.projectRoot).catch(() => null);
        if (stat?.isDirectory()) {
          active.push(parsed);
        }
      }
    } catch {
      // Corrupt/stale workflow state must not break the underlying tool call.
    }
  }

  if (pathsToMatch.length === 0) {
    return active.length === 1 ? active[0] : null;
  }

  return active
    .filter((state) =>
      pathsToMatch.some((candidate) => isWithin(candidate, state.projectRoot))
    )
    .sort((a, b) => b.projectRoot.length - a.projectRoot.length)[0] ?? null;
}

async function activeWorkflowForProjectRoot(
  projectRoot: string,
): Promise<PersistedWorkflowState | null> {
  try {
    const parsed = parseWorkflowState(JSON.parse(
      await fs.readFile(resolveWorkflowStatePath(projectRoot), 'utf8'),
    ));
    if (!parsed || parsed.completedAt) return null;
    const stat = await fs.stat(parsed.projectRoot).catch(() => null);
    if (!stat?.isDirectory()) return null;
    if (workflowProjectIdentity(parsed.projectRoot) !== workflowProjectIdentity(projectRoot)) {
      return null;
    }
    return parsed;
  } catch {
    return null;
  }
}

async function recoverStaleMemoryLock(lockPath: string): Promise<boolean> {
  const stat = await fs.stat(lockPath).catch((error) => {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  });
  if (!stat) return true;
  if (Date.now() - stat.mtimeMs <= MEMORY_STALE_LOCK_MS) return false;

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

async function withMemoryLock<T>(memoryPath: string, operation: () => Promise<T>): Promise<T> {
  const lockPath = memoryPath + '.lock';
  await fs.mkdir(path.dirname(lockPath), { recursive: true });
  let acquired = false;

  for (let attempt = 0; attempt < MEMORY_LOCK_ATTEMPTS; attempt += 1) {
    try {
      await fs.mkdir(lockPath);
      acquired = true;
      break;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      try {
        const stat = await fs.stat(lockPath);
        if (Date.now() - stat.mtimeMs > MEMORY_STALE_LOCK_MS) {
          if (await recoverStaleMemoryLock(lockPath)) continue;
        }
      } catch (statError) {
        if ((statError as NodeJS.ErrnoException).code !== 'ENOENT') throw statError;
      }
      await delay(MEMORY_LOCK_RETRY_MS);
    }
  }

  if (!acquired) throw new Error('Operational memory journal is busy; refusing an unsafe concurrent write');
  try {
    return await operation();
  } finally {
    await fs.rm(lockPath, { recursive: true, force: true }).catch(() => undefined);
  }
}

async function memoryScopeCorrelation(projectRoot: string): Promise<{ projectId: string; repositoryId: string } | undefined> {
  try {
    const identity = await resolveProjectIdentity(projectRoot);
    return { projectId: identity.projectId, repositoryId: identity.repository.repositoryId };
  } catch {
    return undefined;
  }
}

async function appendEvent(projectRoot: string, event: OperationalMemoryEvent): Promise<void> {
  const memoryPath = resolveWorkflowMemoryPath(projectRoot);
  const scope = await memoryScopeCorrelation(projectRoot);
  const prior = memoryWriteChains.get(memoryPath) ?? Promise.resolve();
  const operation = prior.then(() => withMemoryLock(memoryPath, async () => {
    await fs.mkdir(path.dirname(memoryPath), { recursive: true });
    let needsSeparator = false;
    let authorityBeforeAppend = { size: 0, mtimeMs: 0, ctimeMs: 0 };
    try {
      const handle = await fs.open(memoryPath, 'r');
      try {
        const stat = await handle.stat();
        authorityBeforeAppend = { size: stat.size, mtimeMs: stat.mtimeMs, ctimeMs: stat.ctimeMs };
        if (stat.size > 0) {
          const lastByte = Buffer.alloc(1);
          await handle.read(lastByte, 0, 1, stat.size - 1);
          needsSeparator = lastByte[0] !== 0x0a;
        }
      } finally {
        await handle.close();
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
    if (needsSeparator) await fs.appendFile(memoryPath, '\n', 'utf8');
    await fs.appendFile(memoryPath, JSON.stringify(event) + '\n', 'utf8');
    await updateOperationalMemoryIndexAfterAppend(
      memoryPath,
      resolveWorkflowMemoryIndexPath(projectRoot),
      parseMemoryLine,
      scope,
      authorityBeforeAppend,
    ).catch(() => false);
    await updateOperationalMemoryGlobalIndexAfterAppend(
      memoryPath,
      event,
      scope,
      authorityBeforeAppend,
    ).catch(() => false);
  }));
  memoryWriteChains.set(memoryPath, operation.catch(() => undefined));
  await operation;
}

function isWorkflowId(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
}

function parseMemoryEvent(value: unknown): OperationalMemoryEvent | null {
  if (!value || typeof value !== 'object') return null;
  const raw = value as Record<string, unknown>;
  if (
    raw.version !== 1 ||
    typeof raw.id !== 'string' ||
    typeof raw.workflowId !== 'string' ||
    !isWorkflowId(raw.workflowId) ||
    typeof raw.sourceTool !== 'string' ||
    typeof raw.reasonCode !== 'string' ||
    typeof raw.fingerprint !== 'string' ||
    typeof raw.occurredAt !== 'string'
  ) return null;

  const reasonCodes: OperationalReasonCode[] = [
    'approval_required',
    'policy_denied',
    'not_found',
    'permission_denied',
    'timeout',
    'unsupported',
    'validation_error',
    'process_exit_nonzero',
    'process_wait_timeout',
    'learned_pattern',
    'tool_error',
  ];
  if (!reasonCodes.includes(raw.reasonCode as OperationalReasonCode)) return null;

  const reasonCode = raw.reasonCode as OperationalReasonCode;
  const lessonCode =
    reasonCode === 'learned_pattern' && isOperationalLessonCode(raw.lessonCode)
      ? raw.lessonCode
      : undefined;
  if (reasonCode === 'learned_pattern' && !lessonCode) return null;

  const kind: OperationalMemoryKind =
    reasonCode === 'learned_pattern'
      ? 'lesson'
      : reasonCode === 'not_found' ||
        reasonCode === 'validation_error' ||
        reasonCode === 'process_exit_nonzero' ||
        reasonCode === 'tool_error'
        ? 'error'
        : 'limit';
  const sourceTool = safeToolName(raw.sourceTool);
  const family = familyForTool(sourceTool);
  const expectedFingerprint = fingerprintFor(
    kind,
    sourceTool,
    reasonCode,
    family,
    lessonCode,
  );
  if (raw.fingerprint !== expectedFingerprint) return null;
  if (Number.isNaN(Date.parse(raw.occurredAt))) return null;

  const taskId = typeof raw.taskId === 'string' && isWorkflowId(raw.taskId) && raw.taskId === raw.workflowId
    ? raw.taskId : undefined;
  const runId = taskId && typeof raw.runId === 'string' && isWorkflowId(raw.runId)
    ? raw.runId : undefined;
  if ((raw.taskId !== undefined || raw.runId !== undefined) && (!taskId || !runId)) return null;

  const stageId =
    typeof raw.stageId === 'string' && /^[a-z0-9][a-z0-9._-]{0,119}$/i.test(raw.stageId)
      ? raw.stageId
      : undefined;

  return {
    version: 1,
    id: raw.id.slice(0, 120),
    workflowId: raw.workflowId.slice(0, 200),
    ...(taskId ? { taskId } : {}),
    ...(runId ? { runId } : {}),
    kind,
    reasonCode,
    sourceTool,
    family,
    ...(stageId ? { stageId } : {}),
    ...(lessonCode ? { lessonCode } : {}),
    summary: summaryFor(sourceTool, reasonCode, lessonCode),
    lesson: lessonFor(reasonCode, lessonCode),
    fingerprint: expectedFingerprint,
    occurredAt: raw.occurredAt,
  };
}

async function readRecentEventsFromJournal(
  projectRoot: string,
  workflowId: string,
): Promise<OperationalMemoryEvent[]> {
  const memoryPath = resolveWorkflowMemoryPath(projectRoot);
  let handle: Awaited<ReturnType<typeof fs.open>> | undefined;
  try {
    handle = await fs.open(memoryPath, 'r');
    const stat = await handle.stat();
    const start = Math.max(0, stat.size - MAX_MEMORY_TAIL_BYTES);
    const size = stat.size - start;
    const buffer = Buffer.alloc(size);
    await handle.read(buffer, 0, size, start);
    let text = buffer.toString('utf8');
    if (start > 0) {
      const firstNewline = text.indexOf('\n');
      text = firstNewline >= 0 ? text.slice(firstNewline + 1) : '';
    }
    return text
      .split(/\r?\n/)
      .filter(Boolean)
      .slice(-MAX_MEMORY_EVENTS)
      .map((line) => {
        try { return parseMemoryEvent(JSON.parse(line)); } catch { return null; }
      })
      .filter((event): event is OperationalMemoryEvent =>
        !!event && event.workflowId === workflowId
      );
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
    return [];
  } finally {
    await handle?.close().catch(() => undefined);
  }
}

function parseMemoryLine(line: string): OperationalMemoryEvent | null {
  try {
    return parseMemoryEvent(JSON.parse(line));
  } catch {
    return null;
  }
}

async function readRecentEvents(
  projectRoot: string,
  workflowId: string,
): Promise<OperationalMemoryEvent[]> {
  const scope = await memoryScopeCorrelation(projectRoot);
  const indexed = await readOperationalMemoryIndexEvents(
    resolveWorkflowMemoryPath(projectRoot),
    resolveWorkflowMemoryIndexPath(projectRoot),
    workflowId,
    MAX_MEMORY_TAIL_BYTES,
    MAX_MEMORY_EVENTS,
    parseMemoryLine,
    scope,
  );
  if (indexed !== null) {
    return indexed
      .map((event) => parseMemoryEvent({ version: 1, ...event }))
      .filter((event): event is OperationalMemoryEvent =>
        !!event && event.workflowId === workflowId
      );
  }
  return readRecentEventsFromJournal(projectRoot, workflowId);
}

function familyMatchesStage(family: string, stageId?: string): boolean {
  if (!stageId) return false;
  const stage = stageId.toLowerCase();
  if (/inspect|audit|read|research/.test(stage)) return family === 'filesystem.read';
  if (/implement|write|edit|fix/.test(stage)) return family === 'filesystem.write';
  if (/test|verify|build|ci/.test(stage)) return family === 'terminal' || family === 'process';
  return false;
}

function aggregateLessons(
  events: OperationalMemoryEvent[],
  currentStageId?: string,
  context?: OperationalMemoryScopeContext,
): OperationalMemoryLesson[] {
  const groups = new Map<string, OperationalMemoryEvent[]>();
  for (const event of events) {
    const group = groups.get(event.fingerprint) ?? [];
    group.push(event);
    groups.set(event.fingerprint, group);
  }

  const lessons = [...groups.entries()].map(([fingerprint, group]) => {
    const first = group[0];
    const latest = group[group.length - 1];
    const currentRunEvents = context?.runId
      ? group.filter((event) => event.runId === context.runId)
      : [];
    const rankedLatest = currentRunEvents[currentRunEvents.length - 1] ?? latest;
    const latestIndex = events.lastIndexOf(rankedLatest);
    const recency = Math.max(0, 20 - (events.length - 1 - latestIndex));
    let relevanceReason: OperationalMemoryRelevanceReason;
    let band: number;
    if (currentRunEvents.length > 0) {
      if (rankedLatest.stageId && rankedLatest.stageId === currentStageId) {
        relevanceReason = 'current_run_exact_stage';
        band = 500;
      } else if (familyMatchesStage(rankedLatest.family, currentStageId)) {
        relevanceReason = 'current_run_family_match';
        band = 470;
      } else {
        relevanceReason = 'current_run_recent';
        band = 450;
      }
    } else {
      relevanceReason = 'current_task_history';
      band = 400;
    }
    const relevanceScore = band + Math.min(group.length * 3, 18) + Math.min(recency, 18);

    return {
      fingerprint,
      kind: rankedLatest.kind,
      reasonCode: rankedLatest.reasonCode,
      sourceTool: rankedLatest.sourceTool,
      family: rankedLatest.family,
      ...(rankedLatest.stageId ? { stageId: rankedLatest.stageId } : {}),
      ...(rankedLatest.lessonCode ? { lessonCode: rankedLatest.lessonCode } : {}),
      summary: rankedLatest.summary,
      lesson: rankedLatest.lesson,
      occurrences: group.length,
      firstSeenAt: first.occurredAt,
      lastSeenAt: rankedLatest.occurredAt,
      relevanceScore,
      scope: 'workflow' as const,
      relevanceReason,
    } satisfies OperationalMemoryLesson;
  });

  return lessons.sort((a, b) =>
    b.relevanceScore - a.relevanceScore ||
    b.lastSeenAt.localeCompare(a.lastSeenAt)
  );
}
function sameMemoryScope(
  expected: OperationalMemoryScopeCorrelation, candidate: OperationalMemoryScopeCorrelation | null,
): boolean {
  if (!expected.projectId || candidate?.projectId !== expected.projectId) return false;
  if (expected.repositoryId && candidate.repositoryId !== expected.repositoryId) return false;
  return true;
}

async function readProjectHistoryRows(
  projectRoot: string, scope: OperationalMemoryScopeCorrelation,
): Promise<IndexedOperationalMemoryProjectGroup[]> {
  const currentIndex = resolveWorkflowMemoryIndexPath(projectRoot);
  const current = await readOperationalMemoryProjectGroups(
    resolveWorkflowMemoryPath(projectRoot), currentIndex, parseMemoryLine, scope,
  ) ?? [];
  const rows = [...current];
  let entries: string[];
  try { entries = await fs.readdir(resolveWorkflowStateRoot()); } catch { return rows; }
  for (const name of entries) {
    if (!name.endsWith('.memory.sqlite')) continue;
    const candidateIndex = path.join(resolveWorkflowStateRoot(), name);
    if (path.resolve(candidateIndex) === path.resolve(currentIndex)) continue;
    const candidateScope = await readOperationalMemoryIndexCorrelation(candidateIndex);
    if (!sameMemoryScope(scope, candidateScope)) continue;
    const candidateMemory = candidateIndex.slice(0, -'.memory.sqlite'.length) + '.memory.jsonl';
    const memoryStat = await fs.stat(candidateMemory).catch(() => null);
    if (!memoryStat?.isFile()) continue;
    const candidateRows = await readOperationalMemoryProjectGroups(
      candidateMemory, candidateIndex, parseMemoryLine, scope,
    );
    if (candidateRows) rows.push(...candidateRows);
  }
  const merged = new Map<string, IndexedOperationalMemoryProjectGroup>();
  for (const row of rows) {
    const existing = merged.get(row.fingerprint);
    if (!existing) {
      merged.set(row.fingerprint, { ...row });
      continue;
    }
    const latest = row.lastSeenAt > existing.lastSeenAt ? row : existing;
    merged.set(row.fingerprint, {
      ...latest,
      firstSeenAt: row.firstSeenAt < existing.firstSeenAt ? row.firstSeenAt : existing.firstSeenAt,
      lastSeenAt: row.lastSeenAt > existing.lastSeenAt ? row.lastSeenAt : existing.lastSeenAt,
      occurrences: existing.occurrences + row.occurrences,
      distinctWorkflows: existing.distinctWorkflows + row.distinctWorkflows,
    });
  }
  return [...merged.values()];
}

export async function getOperationalMemorySummary(
  projectRoot: string,
  workflowId: string,
  currentStageId?: string,
  context?: OperationalMemoryScopeContext,
): Promise<OperationalMemorySummary> {
  const events = await readRecentEvents(projectRoot, workflowId);
  const workflowLessons = aggregateLessons(events, currentStageId, context);
  const scope = await memoryScopeCorrelation(projectRoot);
  const projectRows = scope ? await readProjectHistoryRows(projectRoot, scope) : [];
  const globalRows = scope ? await readOperationalMemoryGlobalGroups(scope, parseMemoryLine) : [];
  const projectLessons: OperationalMemoryLesson[] = [];
  for (const row of projectRows) {
    const parsed = parseMemoryEvent({ version: 1, id: 'project-group', workflowId: row.latestWorkflowId,
      kind: row.kind, reasonCode: row.reasonCode, lessonCode: row.lessonCode, sourceTool: row.sourceTool,
      family: row.family, stageId: row.stageId, fingerprint: row.fingerprint, occurredAt: row.lastSeenAt });
    if (!parsed) continue;
    let relevanceReason: OperationalMemoryRelevanceReason;
    let band: number;
    if (parsed.stageId && parsed.stageId === currentStageId) { relevanceReason = 'project_exact_stage'; band = 300; }
    else if (familyMatchesStage(parsed.family, currentStageId)) { relevanceReason = 'project_family_match'; band = 270; }
    else if (row.distinctWorkflows > 1 || row.occurrences > 1) { relevanceReason = 'project_repeated'; band = 240; }
    else { relevanceReason = 'project_recent'; band = 220; }
    projectLessons.push({ fingerprint: parsed.fingerprint, kind: parsed.kind, reasonCode: parsed.reasonCode,
      sourceTool: parsed.sourceTool, family: parsed.family, ...(parsed.stageId ? { stageId: parsed.stageId } : {}),
      ...(parsed.lessonCode ? { lessonCode: parsed.lessonCode } : {}), summary: parsed.summary, lesson: parsed.lesson,
      occurrences: row.occurrences, firstSeenAt: row.firstSeenAt, lastSeenAt: row.lastSeenAt,
      relevanceScore: band + Math.min(row.distinctWorkflows * 4, 16) + Math.min(row.occurrences * 2, 12),
      scope: 'project', relevanceReason });
  }
  const globalLessons: OperationalMemoryLesson[] = [];
  for (const row of globalRows) {
    const parsed = parseMemoryEvent({
      version: 1,
      id: 'global-group',
      workflowId: '00000000-0000-4000-8000-000000000000',
      kind: 'lesson',
      reasonCode: 'learned_pattern',
      lessonCode: row.lessonCode,
      sourceTool: 'project_workflow',
      family: 'workflow',
      fingerprint: row.fingerprint,
      occurredAt: row.lastSeenAt,
    });
    if (!parsed) continue;
    const relevanceReason: OperationalMemoryRelevanceReason =
      row.distinctProjects > 1 ? 'global_repeated' : 'global_recent';
    const band = row.distinctProjects > 1 ? 160 : 140;
    globalLessons.push({
      fingerprint: parsed.fingerprint,
      kind: parsed.kind,
      reasonCode: parsed.reasonCode,
      sourceTool: parsed.sourceTool,
      family: parsed.family,
      ...(parsed.lessonCode ? { lessonCode: parsed.lessonCode } : {}),
      summary: parsed.summary,
      lesson: parsed.lesson,
      occurrences: row.occurrences,
      firstSeenAt: row.firstSeenAt,
      lastSeenAt: row.lastSeenAt,
      relevanceScore: band + Math.min(row.distinctProjects * 4, 12) + Math.min(row.occurrences * 2, 12),
      scope: 'global',
      relevanceReason,
    });
  }
  const deduped = new Map<string, OperationalMemoryLesson>();
  for (const lesson of [...workflowLessons, ...projectLessons, ...globalLessons]) if (!deduped.has(lesson.fingerprint)) deduped.set(lesson.fingerprint, lesson);
  const lessons = [...deduped.values()].sort((a, b) => b.relevanceScore - a.relevanceScore || b.lastSeenAt.localeCompare(a.lastSeenAt));
  return { totalEvents: events.length, uniqueLessons: lessons.length, lessons: lessons.slice(0, MAX_RELEVANT_LESSONS) };
}

export async function recordOperationalToolFailure(
  input: RecordOperationalToolFailureInput,
): Promise<boolean> {
  if (!input.result.isError && !input.policyDecision && !input.observedReasonCode) {
    return false;
  }
  if (input.tool === 'project_workflow') return false;

  const pathsToMatch = candidatePaths(input.args);
  const state = await activeWorkflowForPaths(pathsToMatch);
  if (!state) return false;

  const tool = safeToolName(input.tool);
  const family = familyForTool(tool);
  const classified = classifyFailure(
    input.result,
    input.policyDecision,
    input.observedReasonCode,
  );
  const stageId = nextStageId(state);
  const event: OperationalMemoryEvent = {
    version: 1,
    id: crypto.randomUUID(),
    workflowId: state.workflowId,
    ...(state.taskId ? { taskId: state.taskId } : {}),
    ...(state.runId ? { runId: state.runId } : {}),
    kind: classified.kind,
    reasonCode: classified.reasonCode,
    sourceTool: tool,
    family,
    ...(stageId ? { stageId } : {}),
    summary: summaryFor(tool, classified.reasonCode),
    lesson: lessonFor(classified.reasonCode),
    fingerprint: fingerprintFor(
      classified.kind,
      tool,
      classified.reasonCode,
      family,
    ),
    occurredAt: new Date().toISOString(),
  };

  await appendEvent(state.projectRoot, event);
  return true;
}

export async function recordOperationalLesson(
  input: RecordOperationalLessonInput,
): Promise<boolean> {
  if (!isOperationalLessonCode(input.lessonCode)) return false;
  const state = await activeWorkflowForProjectRoot(input.projectRoot);
  if (!state) return false;

  const tool = 'project_workflow';
  const family = familyForTool(tool);
  const reasonCode: OperationalReasonCode = 'learned_pattern';
  const kind: OperationalMemoryKind = 'lesson';
  const stageId = nextStageId(state);
  const event: OperationalMemoryEvent = {
    version: 1,
    id: crypto.randomUUID(),
    workflowId: state.workflowId,
    ...(state.taskId ? { taskId: state.taskId } : {}),
    ...(state.runId ? { runId: state.runId } : {}),
    kind,
    reasonCode,
    lessonCode: input.lessonCode,
    sourceTool: tool,
    family,
    ...(stageId ? { stageId } : {}),
    summary: summaryFor(tool, reasonCode, input.lessonCode),
    lesson: lessonFor(reasonCode, input.lessonCode),
    fingerprint: fingerprintFor(
      kind,
      tool,
      reasonCode,
      family,
      input.lessonCode,
    ),
    occurredAt: new Date().toISOString(),
  };

  await appendEvent(state.projectRoot, event);
  return true;
}

export { resolveWorkflowMemoryPath };
