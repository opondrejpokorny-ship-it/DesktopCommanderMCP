import { createHash } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  writeFileSync,
} from 'node:fs';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const AUTHORITATIVE_PROTOTYPE = 'prototype/free-pro-team';
const GRAPHIFY_PATHSPEC = [
  '.',
  ':(exclude)graphify-out/**',
  ':(exclude).tools/**',
];

export class GraphifyPreflightError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.name = 'GraphifyPreflightError';
    this.code = code;
    this.details = details;
  }
}

function normalizeRoot(value, { platform = process.platform, realpath = realpathSync.native ?? realpathSync } = {}) {
  let resolved;
  try {
    resolved = realpath(value);
  } catch {
    resolved = path.resolve(value);
  }

  if (platform === 'win32') {
    return String(resolved)
      .replaceAll('/', '\\')
      .replace(/\\+$/, '')
      .toLowerCase();
  }

  return String(resolved).replace(/\/+$/, '');
}

export function repositoryRootsEquivalent(left, right, options = {}) {
  return normalizeRoot(left, options) === normalizeRoot(right, options);
}

function git(repoPath, args, { allowFailure = false, encoding = 'utf8' } = {}) {
  const result = spawnSync(
    'git',
    ['-c', `safe.directory=${repoPath}`, '-C', repoPath, ...args],
    {
      encoding,
      windowsHide: true,
      maxBuffer: 32 * 1024 * 1024,
    },
  );

  if (result.error) {
    throw new GraphifyPreflightError(
      'git_execution_failed',
      `Git could not run: ${result.error.message}`,
      { args },
    );
  }

  if (result.status !== 0 && !allowFailure) {
    const stderr = encoding
      ? String(result.stderr ?? '').trim()
      : Buffer.from(result.stderr ?? []).toString('utf8').trim();
    throw new GraphifyPreflightError(
      'git_command_failed',
      `git ${args.join(' ')} failed${stderr ? `: ${stderr}` : ''}`,
      { args, status: result.status },
    );
  }

  return result;
}

function gitText(repoPath, args, options = {}) {
  const result = git(repoPath, args, { ...options, encoding: 'utf8' });
  return {
    ...result,
    stdout: String(result.stdout ?? '').trim(),
    stderr: String(result.stderr ?? '').trim(),
  };
}

function tryRevParse(repoPath, ref) {
  const result = gitText(repoPath, ['rev-parse', '--verify', ref], { allowFailure: true });
  return result.status === 0 ? result.stdout : null;
}

function listRemotes(repoPath) {
  const output = gitText(repoPath, ['remote']).stdout;
  return new Set(output.split(/\r?\n/).map(value => value.trim()).filter(Boolean));
}

function fetchRemote(repoPath, remote) {
  const result = gitText(repoPath, ['fetch', '--prune', remote], { allowFailure: true });
  if (result.status !== 0) {
    throw new GraphifyPreflightError(
      'remote_fetch_failed',
      `Unable to fetch ${remote}; Graphify preflight refuses to continue with stale remote refs.`,
      { remote, stderr: result.stderr },
    );
  }
}

function relationToRef(repoPath, leftRef, rightRef) {
  const result = gitText(repoPath, ['rev-list', '--left-right', '--count', `${leftRef}...${rightRef}`]);
  const [leftOnly, rightOnly] = result.stdout.split(/\s+/).map(Number);

  if (leftOnly === 0 && rightOnly === 0) return 'equal';
  if (leftOnly === 0 && rightOnly > 0) return 'behind';
  if (leftOnly > 0 && rightOnly === 0) return 'ahead';
  return 'diverged';
}

function statusBuffer(repoPath) {
  return git(repoPath, ['status', '--porcelain=v1', '-z', '--untracked-files=all', '--', ...GRAPHIFY_PATHSPEC], { encoding: null }).stdout ?? Buffer.alloc(0);
}

function computeWorktreeFingerprint(repoPath) {
  const hash = createHash('sha256');
  const status = statusBuffer(repoPath);
  hash.update(status);

  const diff = git(repoPath, ['diff', '--binary', 'HEAD', '--', ...GRAPHIFY_PATHSPEC], { encoding: null }).stdout ?? Buffer.alloc(0);
  hash.update(diff);

  const untracked = git(repoPath, ['ls-files', '--others', '--exclude-standard', '-z', '--', ...GRAPHIFY_PATHSPEC], { encoding: null }).stdout ?? Buffer.alloc(0);
  const paths = Buffer.from(untracked)
    .toString('utf8')
    .split('\0')
    .filter(Boolean)
    .sort();

  for (const relativePath of paths) {
    hash.update(relativePath);
    hash.update('\0');
    try {
      hash.update(readFileSync(path.join(repoPath, relativePath)));
    } catch (error) {
      hash.update(`<unreadable:${error.code ?? error.name}>`);
    }
    hash.update('\0');
  }

  return hash.digest('hex');
}

function readFreshnessState(statePath) {
  if (!existsSync(statePath)) return null;

  try {
    const parsed = JSON.parse(readFileSync(statePath, 'utf8'));
    return parsed && typeof parsed === 'object' ? parsed : null;
  } catch {
    return null;
  }
}

function defaultGraphPath(repoPath) {
  return path.join(repoPath, 'graphify-out', 'graph.json');
}

function defaultStatePath(repoPath) {
  return path.join(repoPath, 'graphify-out', '.graphify-state.json');
}

function assertRepositoryRoot(repoPath) {
  const topLevel = gitText(repoPath, ['rev-parse', '--show-toplevel']).stdout;
  if (!repositoryRootsEquivalent(repoPath, topLevel)) {
    throw new GraphifyPreflightError(
      'repository_root_mismatch',
      `Graphify wrapper must target the repository root. Requested ${repoPath}; Git reports ${topLevel}.`,
      { requested: repoPath, actual: topLevel },
    );
  }
}

function inspectCurrentState(repoPath) {
  const branch = gitText(repoPath, ['branch', '--show-current']).stdout;
  if (!branch) {
    throw new GraphifyPreflightError(
      'detached_head',
      'Graphify preflight refuses automatic repository actions on a detached HEAD.',
    );
  }

  const head = gitText(repoPath, ['rev-parse', 'HEAD']).stdout;
  const status = statusBuffer(repoPath);
  return {
    branch,
    head,
    dirty: status.length > 0,
    worktreeFingerprint: computeWorktreeFingerprint(repoPath),
  };
}

function prototypeBaselineCurrent(repoPath, branch, originPrototype) {
  if (!originPrototype) return null;
  if (branch === AUTHORITATIVE_PROTOTYPE) {
    return gitText(repoPath, ['rev-parse', 'HEAD']).stdout === originPrototype;
  }

  const mergeBase = gitText(repoPath, ['merge-base', 'HEAD', 'origin/prototype/free-pro-team'], {
    allowFailure: true,
  });
  return mergeBase.status === 0 ? mergeBase.stdout === originPrototype : false;
}

function freshnessMatches(state, current) {
  if (!state) return false;

  return state.head === current.head
    && state.branch === current.branch
    && state.prototypeBase === current.originPrototype
    && state.worktreeFingerprint === current.worktreeFingerprint;
}

export async function runGitPreflight({
  repoPath,
  graphPath,
  statePath,
  fetch = true,
} = {}) {
  if (!repoPath) {
    throw new GraphifyPreflightError('repo_required', 'repoPath is required.');
  }

  const repo = path.resolve(repoPath);
  assertRepositoryRoot(repo);

  const remotes = listRemotes(repo);
  if (fetch) {
    if (remotes.has('origin')) fetchRemote(repo, 'origin');
    if (remotes.has('upstream')) fetchRemote(repo, 'upstream');
  }

  let current = inspectCurrentState(repo);
  let originPrototype = tryRevParse(repo, 'origin/prototype/free-pro-team');
  const originMain = tryRevParse(repo, 'origin/main');
  const upstreamMain = remotes.has('upstream') ? tryRevParse(repo, 'upstream/main') : null;
  const warnings = [];
  let fastForwarded = false;
  let initialRelationToOriginPrototype = null;

  if (originPrototype) {
    initialRelationToOriginPrototype = relationToRef(repo, 'HEAD', 'origin/prototype/free-pro-team');
  }

  if (current.branch === AUTHORITATIVE_PROTOTYPE) {
    if (!originPrototype) {
      throw new GraphifyPreflightError(
        'origin_prototype_missing',
        'origin/prototype/free-pro-team is missing; automatic synchronization is refused.',
      );
    }

    if (initialRelationToOriginPrototype === 'behind') {
      if (current.dirty) {
        throw new GraphifyPreflightError(
          'prototype_dirty_behind',
          'origin/prototype/free-pro-team advanced while the local working tree contains changes. Automatic synchronization refused.',
        );
      }

      gitText(repo, ['merge', '--ff-only', 'origin/prototype/free-pro-team']);
      fastForwarded = true;
      current = inspectCurrentState(repo);
      originPrototype = tryRevParse(repo, 'origin/prototype/free-pro-team');
    } else if (initialRelationToOriginPrototype === 'ahead') {
      throw new GraphifyPreflightError(
        'prototype_ahead',
        'Local prototype/free-pro-team is ahead of origin. Automatic synchronization/reset refused.',
      );
    } else if (initialRelationToOriginPrototype === 'diverged') {
      throw new GraphifyPreflightError(
        'prototype_diverged',
        'Local prototype/free-pro-team diverged from origin. Automatic merge/rebase/reset refused.',
      );
    }
  }

  let mainMirrorAligned = null;
  if (current.branch === 'main') {
    mainMirrorAligned = Boolean(
      originMain
      && (!upstreamMain || originMain === upstreamMain)
      && current.head === originMain
      && (!upstreamMain || current.head === upstreamMain),
    );

    if (originMain && current.head !== originMain) warnings.push('local_main_origin_drift');
    if (upstreamMain && current.head !== upstreamMain) warnings.push('upstream_main_drift');
    if (originMain && upstreamMain && originMain !== upstreamMain) {
      warnings.push('origin_main_upstream_drift');
    }
  }

  const relationToOriginPrototype = originPrototype
    ? relationToRef(repo, 'HEAD', 'origin/prototype/free-pro-team')
    : null;
  const prototypeCurrent = prototypeBaselineCurrent(repo, current.branch, originPrototype);

  if (
    current.branch !== AUTHORITATIVE_PROTOTYPE
    && current.branch !== 'main'
    && prototypeCurrent === false
  ) {
    warnings.push('feature_branch_prototype_baseline_advanced');
  }

  const resolvedGraphPath = graphPath ? path.resolve(graphPath) : defaultGraphPath(repo);
  const resolvedStatePath = statePath ? path.resolve(statePath) : defaultStatePath(repo);
  const state = readFreshnessState(resolvedStatePath);
  const graphExists = existsSync(resolvedGraphPath);
  const freshnessContext = {
    ...current,
    originPrototype,
  };

  const refreshRequired = fastForwarded
    || !graphExists
    || !freshnessMatches(state, freshnessContext);

  return {
    repoPath: repo,
    branch: current.branch,
    head: current.head,
    dirty: current.dirty,
    worktreeFingerprint: current.worktreeFingerprint,
    originPrototype,
    originMain,
    upstreamMain,
    initialRelationToOriginPrototype,
    relationToOriginPrototype,
    prototypeBaselineCurrent: prototypeCurrent,
    mainMirrorAligned,
    fastForwarded,
    refreshRequired,
    graphPath: resolvedGraphPath,
    statePath: resolvedStatePath,
    warnings,
  };
}

export async function markGraphFresh({
  repoPath,
  graphPath,
  statePath,
} = {}) {
  if (!repoPath) {
    throw new GraphifyPreflightError('repo_required', 'repoPath is required.');
  }

  const repo = path.resolve(repoPath);
  assertRepositoryRoot(repo);
  const current = inspectCurrentState(repo);
  const originPrototype = tryRevParse(repo, 'origin/prototype/free-pro-team');
  const resolvedGraphPath = graphPath ? path.resolve(graphPath) : defaultGraphPath(repo);
  const resolvedStatePath = statePath ? path.resolve(statePath) : defaultStatePath(repo);

  if (!existsSync(resolvedGraphPath)) {
    throw new GraphifyPreflightError(
      'graph_missing',
      `Cannot mark Graphify fresh because ${resolvedGraphPath} does not exist.`,
    );
  }

  const state = {
    head: current.head,
    branch: current.branch,
    prototypeBase: originPrototype,
    worktreeFingerprint: current.worktreeFingerprint,
    generatedAt: new Date().toISOString(),
  };

  mkdirSync(path.dirname(resolvedStatePath), { recursive: true });
  writeFileSync(resolvedStatePath, `${JSON.stringify(state, null, 2)}\n`, 'utf8');
  return state;
}

function parseCliArgs(argv) {
  const result = {
    repoPath: null,
    graphPath: null,
    statePath: null,
    markFresh: false,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--mark-fresh') {
      result.markFresh = true;
    } else if (arg === '--repo') {
      result.repoPath = argv[++index];
    } else if (arg === '--graph') {
      result.graphPath = argv[++index];
    } else if (arg === '--state') {
      result.statePath = argv[++index];
    } else {
      throw new GraphifyPreflightError('unknown_argument', `Unknown argument: ${arg}`);
    }
  }

  return result;
}

async function main() {
  const options = parseCliArgs(process.argv.slice(2));
  if (!options.repoPath) {
    throw new GraphifyPreflightError('repo_required', '--repo <path> is required.');
  }

  if (options.markFresh) {
    const state = await markGraphFresh(options);
    console.log(`Graphify state recorded for ${state.branch} @ ${state.head}.`);
    return;
  }

  const result = await runGitPreflight(options);
  console.log(JSON.stringify(result, null, 2));
  process.exitCode = result.refreshRequired ? 10 : 0;
}

const invokedPath = process.argv[1] ? path.resolve(process.argv[1]) : null;
if (invokedPath && invokedPath === fileURLToPath(import.meta.url)) {
  main().catch(error => {
    if (error instanceof GraphifyPreflightError) {
      console.error(`Graphify preflight refused: [${error.code}] ${error.message}`);
      process.exitCode = 20;
      return;
    }

    console.error(error);
    process.exitCode = 21;
  });
}
