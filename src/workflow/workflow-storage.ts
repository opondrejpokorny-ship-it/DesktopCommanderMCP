import crypto from 'node:crypto';
import path from 'node:path';
import { USER_HOME } from '../config.js';

export function resolveWorkflowStateRoot(): string {
  return path.resolve(
    process.env.DESKTOP_COMMANDER_WORKFLOW_STATE_DIR ??
      path.join(USER_HOME, '.claude-server-commander', 'project-workflow'),
  );
}

export function workflowProjectIdentity(projectRoot: string): string {
  const normalized = path.normalize(path.resolve(projectRoot));
  return process.platform === 'win32' ? normalized.toLowerCase() : normalized;
}

export function workflowProjectDigest(projectRoot: string): string {
  return crypto
    .createHash('sha256')
    .update(workflowProjectIdentity(projectRoot))
    .digest('hex')
    .slice(0, 24);
}
export function resolveWorkflowStatePath(projectRoot: string): string {
  return path.join(
    resolveWorkflowStateRoot(),
    workflowProjectDigest(projectRoot) + '.json',
  );
}

export function resolveWorkflowMemoryPath(projectRoot: string): string {
  return path.join(
    resolveWorkflowStateRoot(),
    workflowProjectDigest(projectRoot) + '.memory.jsonl',
  );
}

export function resolveWorkflowMemoryIndexPath(projectRoot: string): string {
  return path.join(
    resolveWorkflowStateRoot(),
    workflowProjectDigest(projectRoot) + '.memory.sqlite',
  );
}
