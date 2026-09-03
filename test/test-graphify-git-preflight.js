import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import {
  GraphifyPreflightError,
  markGraphFresh,
  repositoryRootsEquivalent,
  runGitPreflight,
} from '../scripts/graphify-git-preflight.mjs';

function git(cwd, ...args) {
  const result = spawnSync('git', [
    '-c', 'user.name=Graphify Test',
    '-c', 'user.email=graphify@example.invalid',
    ...args,
  ], { cwd, encoding: 'utf8' });
  if (result.status !== 0) {
    throw new Error(`git ${args.join(' ')} failed\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`);
  }
  return result.stdout.trim();
}

async function createFixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), 'dc-graphify-preflight-'));
  const origin = path.join(root, 'origin.git');
  const upstream = path.join(root, 'upstream.git');
  const seed = path.join(root, 'seed');
  const local = path.join(root, 'local');

  await mkdir(origin);
  await mkdir(upstream);
  await mkdir(seed);

  git(origin, 'init', '--bare');
  git(upstream, 'init', '--bare');
  git(seed, 'init');
  await writeFile(path.join(seed, 'tracked.txt'), 'A\n');
  git(seed, 'add', 'tracked.txt');
  git(seed, 'commit', '-m', 'A');
  git(seed, 'branch', '-M', 'main');
  git(seed, 'remote', 'add', 'origin', origin);
  git(seed, 'remote', 'add', 'upstream', upstream);
  git(seed, 'push', 'origin', 'main');
  git(seed, 'push', 'upstream', 'main');
  git(seed, 'checkout', '-b', 'prototype/free-pro-team');
  git(seed, 'push', 'origin', 'prototype/free-pro-team');

  git(root, 'clone', '--branch', 'prototype/free-pro-team', origin, local);
  git(local, 'remote', 'add', 'upstream', upstream);

  return { root, origin, upstream, seed, local };
}

async function advancePrototype(fixture, label = 'B') {
  git(fixture.seed, 'checkout', 'prototype/free-pro-team');
  await writeFile(path.join(fixture.seed, 'tracked.txt'), `${label}\n`, { flag: 'a' });
  git(fixture.seed, 'add', 'tracked.txt');
  git(fixture.seed, 'commit', '-m', label);
  git(fixture.seed, 'push', 'origin', 'prototype/free-pro-team');
  return git(fixture.seed, 'rev-parse', 'HEAD');
}

async function advanceUpstreamMain(fixture, label = 'upstream-B') {
  git(fixture.seed, 'checkout', 'main');
  await writeFile(path.join(fixture.seed, 'upstream.txt'), `${label}\n`);
  git(fixture.seed, 'add', 'upstream.txt');
  git(fixture.seed, 'commit', '-m', label);
  git(fixture.seed, 'push', 'upstream', 'main');
  return git(fixture.seed, 'rev-parse', 'HEAD');
}

test('clean prototype behind origin fast-forwards only and requires graph refresh', async () => {
  const fixture = await createFixture();
  const before = git(fixture.local, 'rev-parse', 'HEAD');
  const remote = await advancePrototype(fixture);

  const result = await runGitPreflight({ repoPath: fixture.local });

  assert.equal(result.branch, 'prototype/free-pro-team');
  assert.equal(result.relationToOriginPrototype, 'equal');
  assert.equal(result.fastForwarded, true);
  assert.equal(result.refreshRequired, true);
  assert.equal(git(fixture.local, 'rev-parse', 'HEAD'), remote);
  assert.notEqual(before, remote);
});

test('dirty prototype behind origin fails closed and preserves local bytes', async () => {
  const fixture = await createFixture();
  await writeFile(path.join(fixture.local, 'tracked.txt'), 'local dirty bytes\n');
  const beforeBytes = await readFile(path.join(fixture.local, 'tracked.txt'));
  const beforeHead = git(fixture.local, 'rev-parse', 'HEAD');
  await advancePrototype(fixture);

  await assert.rejects(
    () => runGitPreflight({ repoPath: fixture.local }),
    error => error instanceof GraphifyPreflightError && error.code === 'prototype_dirty_behind',
  );

  assert.equal(git(fixture.local, 'rev-parse', 'HEAD'), beforeHead);
  assert.deepEqual(await readFile(path.join(fixture.local, 'tracked.txt')), beforeBytes);
});

test('prototype ahead fails closed without reset', async () => {
  const fixture = await createFixture();
  await writeFile(path.join(fixture.local, 'local.txt'), 'ahead\n');
  git(fixture.local, 'add', 'local.txt');
  git(fixture.local, 'commit', '-m', 'local ahead');
  const beforeHead = git(fixture.local, 'rev-parse', 'HEAD');

  await assert.rejects(
    () => runGitPreflight({ repoPath: fixture.local }),
    error => error instanceof GraphifyPreflightError && error.code === 'prototype_ahead',
  );

  assert.equal(git(fixture.local, 'rev-parse', 'HEAD'), beforeHead);
});

test('diverged prototype fails closed without merge or rebase', async () => {
  const fixture = await createFixture();
  await writeFile(path.join(fixture.local, 'local.txt'), 'local\n');
  git(fixture.local, 'add', 'local.txt');
  git(fixture.local, 'commit', '-m', 'local divergent');
  const beforeHead = git(fixture.local, 'rev-parse', 'HEAD');
  await advancePrototype(fixture, 'remote divergent');

  await assert.rejects(
    () => runGitPreflight({ repoPath: fixture.local }),
    error => error instanceof GraphifyPreflightError && error.code === 'prototype_diverged',
  );

  assert.equal(git(fixture.local, 'rev-parse', 'HEAD'), beforeHead);
});

test('dirty feature branch is never synchronized and forces refresh', async () => {
  const fixture = await createFixture();
  git(fixture.local, 'checkout', '-b', 'feat/example');
  const beforeHead = git(fixture.local, 'rev-parse', 'HEAD');
  await writeFile(path.join(fixture.local, 'tracked.txt'), 'feature dirty\n');
  await advancePrototype(fixture);

  const result = await runGitPreflight({ repoPath: fixture.local });

  assert.equal(result.branch, 'feat/example');
  assert.equal(result.dirty, true);
  assert.equal(result.fastForwarded, false);
  assert.equal(result.refreshRequired, true);
  assert.equal(result.prototypeBaselineCurrent, false);
  assert.equal(git(fixture.local, 'rev-parse', 'HEAD'), beforeHead);
});

test('clean feature branch reports prototype movement but does not mutate branch', async () => {
  const fixture = await createFixture();
  git(fixture.local, 'checkout', '-b', 'feat/example');
  const beforeHead = git(fixture.local, 'rev-parse', 'HEAD');
  await advancePrototype(fixture);

  const result = await runGitPreflight({ repoPath: fixture.local });

  assert.equal(result.branch, 'feat/example');
  assert.equal(result.fastForwarded, false);
  assert.equal(result.prototypeBaselineCurrent, false);
  assert.equal(git(fixture.local, 'rev-parse', 'HEAD'), beforeHead);
});

test('main reports upstream drift and never mutates local main', async () => {
  const fixture = await createFixture();
  git(fixture.local, 'checkout', 'main');
  const beforeHead = git(fixture.local, 'rev-parse', 'HEAD');
  const upstreamHead = await advanceUpstreamMain(fixture);

  const result = await runGitPreflight({ repoPath: fixture.local });

  assert.equal(result.branch, 'main');
  assert.equal(result.fastForwarded, false);
  assert.equal(result.mainMirrorAligned, false);
  assert.equal(result.upstreamMain, upstreamHead);
  assert.ok(result.warnings.includes('upstream_main_drift'));
  assert.equal(git(fixture.local, 'rev-parse', 'HEAD'), beforeHead);
});

test('freshness metadata avoids rebuild until HEAD changes', async () => {
  const fixture = await createFixture();
  git(fixture.local, 'checkout', '-b', 'feat/freshness');
  const graphDir = path.join(fixture.local, 'graphify-out');
  const graphPath = path.join(graphDir, 'graph.json');
  const statePath = path.join(graphDir, '.graphify-state.json');
  await mkdir(graphDir, { recursive: true });
  await writeFile(graphPath, '{}\n');

  await markGraphFresh({ repoPath: fixture.local, statePath, graphPath });
  const fresh = await runGitPreflight({ repoPath: fixture.local, statePath, graphPath });
  assert.equal(fresh.refreshRequired, false);

  await writeFile(path.join(fixture.local, 'new-code.js'), 'export const x = 1;\n');
  git(fixture.local, 'add', 'new-code.js');
  git(fixture.local, 'commit', '-m', 'feature change');
  const stale = await runGitPreflight({ repoPath: fixture.local, statePath, graphPath });
  assert.equal(stale.refreshRequired, true);
});

test('Windows repository identity uses canonical resolution rather than raw string equality', () => {
  const longPath = 'C:\\Windows\\ServiceProfiles\\NetworkService\\repo';
  const shortPath = 'C:\\WINDOWS\\SERVIC~1\\NETWOR~1\\repo';
  const canonical = 'c:\\windows\\serviceprofiles\\networkservice\\repo';

  const equivalent = repositoryRootsEquivalent(longPath, shortPath, {
    platform: 'win32',
    realpath: value => {
      if (value === longPath || value === shortPath) return canonical;
      return value;
    },
  });

  assert.equal(equivalent, true);
  assert.notEqual(longPath.toLowerCase(), shortPath.toLowerCase());
});

test('wrapper and ignore rules preserve local code-only privacy boundaries', async () => {
  const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  const wrapper = await readFile(path.join(repoRoot, 'scripts', 'graphify-local.cmd'), 'utf8');
  const ignore = await readFile(path.join(repoRoot, '.gitignore'), 'utf8');

  assert.match(wrapper, /graphify(?:\.exe)?"?\s+extract/i);
  assert.match(wrapper, /--code-only/i);
  assert.doesNotMatch(wrapper, /--backend\s+(openai|claude|gemini|deepseek|kimi|azure|bedrock)/i);
  assert.match(ignore, /^\.tools\/$/m);
  assert.match(ignore, /^graphify-out\/$/m);
});
