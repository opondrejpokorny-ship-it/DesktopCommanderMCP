import fs from 'node:fs/promises';
import path from 'node:path';

export const OPERATIONAL_MEMORY_ACTIVE_SUFFIX = '.memory.jsonl';
export const OPERATIONAL_MEMORY_DEFAULT_ROTATION_BYTES = 24 * 1024 * 1024;
// Test-only override; production rotation is intentionally not configurable through ordinary env/config.
const TEST_ROTATION_ENV = 'DESKTOP_COMMANDER_TEST_OPERATIONAL_MEMORY_ROTATION_BYTES';

export interface OperationalMemoryJournalSegment {
  path: string;
  name: string;
  sequence?: number;
  active: boolean;
  size: number;
  mtimeMs: number;
  ctimeMs: number;
}

export interface OperationalMemoryAuthoritySnapshot {
  segments: OperationalMemoryJournalSegment[];
  totalSize: number;
  archivedBytes: number;
  activeSize: number;
  mtimeMs: number;
  ctimeMs: number;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function archiveMatcher(memoryPath: string): RegExp {
  const activeName = path.basename(memoryPath);
  if (!activeName.endsWith(OPERATIONAL_MEMORY_ACTIVE_SUFFIX)) {
    throw new Error('Operational memory path does not use the active journal suffix');
  }
  const stem = activeName.slice(0, -'.jsonl'.length);
  return new RegExp('^' + escapeRegExp(stem) + '\\.([0-9]{6})\\.jsonl$');
}

async function fileSegment(
  filePath: string,
  name: string,
  active: boolean,
  sequence?: number,
): Promise<OperationalMemoryJournalSegment | null> {
  const stat = await fs.stat(filePath).catch((error) => {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  });
  if (!stat?.isFile()) return null;
  return {
    path: filePath, name, active, ...(sequence === undefined ? {} : { sequence }),
    size: stat.size, mtimeMs: stat.mtimeMs, ctimeMs: stat.ctimeMs,
  };
}

export async function listOperationalMemoryJournalSegments(
  memoryPath: string,
): Promise<OperationalMemoryJournalSegment[]> {
  const directory = path.dirname(memoryPath);
  const matcher = archiveMatcher(memoryPath);
  let names: string[] = [];
  try { names = await fs.readdir(directory); } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }

  const archives: OperationalMemoryJournalSegment[] = [];
  for (const name of names) {
    const match = matcher.exec(name);
    if (!match) continue;
    const sequence = Number(match[1]);
    const segment = await fileSegment(path.join(directory, name), name, false, sequence);
    if (segment) archives.push(segment);
  }
  archives.sort((a, b) => (a.sequence ?? 0) - (b.sequence ?? 0));

  const activeName = path.basename(memoryPath);
  const active = await fileSegment(memoryPath, activeName, true);
  return active ? [...archives, active] : archives;
}

export async function getOperationalMemoryAuthoritySnapshot(
  memoryPath: string,
): Promise<OperationalMemoryAuthoritySnapshot> {
  const segments = await listOperationalMemoryJournalSegments(memoryPath);
  const archived = segments.filter((segment) => !segment.active);
  const active = segments.find((segment) => segment.active);
  return {
    segments,
    totalSize: segments.reduce((sum, segment) => sum + segment.size, 0),
    archivedBytes: archived.reduce((sum, segment) => sum + segment.size, 0),
    activeSize: active?.size ?? 0,
    mtimeMs: segments.reduce((value, segment) => value + segment.mtimeMs, 0),
    ctimeMs: segments.reduce((value, segment) => value + segment.ctimeMs, 0),
  };
}

export function operationalMemoryRotationBytes(): number {
  if (process.env.NODE_ENV !== 'test') return OPERATIONAL_MEMORY_DEFAULT_ROTATION_BYTES;
  const configured = Number(process.env[TEST_ROTATION_ENV]);
  if (Number.isSafeInteger(configured) && configured >= 1024) return configured;
  return OPERATIONAL_MEMORY_DEFAULT_ROTATION_BYTES;
}

export async function rotateOperationalMemoryJournalIfNeeded(
  memoryPath: string,
): Promise<boolean> {
  const active = await fs.stat(memoryPath).catch((error) => {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  });
  if (!active?.isFile() || active.size === 0 || active.size < operationalMemoryRotationBytes()) {
    return false;
  }

  const segments = await listOperationalMemoryJournalSegments(memoryPath);
  const highest = segments.reduce(
    (value, segment) => Math.max(value, segment.sequence ?? 0),
    0,
  );
  const next = highest + 1;
  if (next > 999999) throw new Error('Operational memory archive sequence exhausted');
  const archivePath = memoryPath.slice(0, -'.jsonl'.length) + '.' + String(next).padStart(6, '0') + '.jsonl';
  const collision = await fs.stat(archivePath).then(() => true, () => false);
  if (collision) throw new Error('Operational memory archive target already exists');
  await fs.rename(memoryPath, archivePath);
  return true;
}

export async function readOperationalMemoryJournalTail(
  memoryPath: string,
  maxBytes: number,
): Promise<string> {
  if (!Number.isSafeInteger(maxBytes) || maxBytes <= 0) return '';
  const snapshot = await getOperationalMemoryAuthoritySnapshot(memoryPath);
  let remaining = maxBytes;
  const chunks: string[] = [];
  for (let index = snapshot.segments.length - 1; index >= 0 && remaining > 0; index -= 1) {
    const segment = snapshot.segments[index];
    const take = Math.min(segment.size, remaining);
    if (take <= 0) continue;
    const handle = await fs.open(segment.path, 'r');
    try {
      const buffer = Buffer.alloc(take);
      const start = segment.size - take;
      const { bytesRead } = await handle.read(buffer, 0, take, start);
      let text = buffer.subarray(0, bytesRead).toString('utf8');
      if (start > 0) {
        const firstNewline = text.indexOf('\n');
        text = firstNewline >= 0 ? text.slice(firstNewline + 1) : '';
      }
      if (text.length > 0) chunks.push(text);
    } finally {
      await handle.close();
    }
    remaining -= take;
  }
  return chunks.reverse().join('\n');
}
