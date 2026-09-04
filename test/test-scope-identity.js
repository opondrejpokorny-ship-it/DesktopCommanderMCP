/**
 * RED -> GREEN contract tests for shared scope identity primitives.
 */
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import {
  SCOPE_KINDS,
  deriveProjectId,
  resolveProjectIdentity,
  resolveRepositoryIdentity,
} from '../dist/workflow/scope-identity.js';

const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'dc-scope-identity-'));
const repoRoot = path.join(tempDir, 'repo');
const worktreeRoot = path.join(tempDir, 'repo-worktree');

function git(cwd, ...args) {
  return execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8' }).trim();
}

function digest(value) {
  return crypto.createHash('sha256').update(value, 'utf8').digest('hex');
}

try {
  await fs.mkdir(repoRoot, { recursive: true });
  execFileSync('git', ['init', repoRoot]);
  git(repoRoot, 'config', 'user.email', 'scope-test@example.invalid');
  git(repoRoot, 'config', 'user.name', 'Scope Identity Test');
  await fs.writeFile(path.join(repoRoot, 'README.md'), '# Scope identity\n');
  git(repoRoot, 'add', '.');
  git(repoRoot, 'commit', '-m', 'baseline');
  git(
    repoRoot,
    'remote',
    'add',
    'origin',
    'https://token-user:ghp_secret_should_not_leak@github.com/Example/RegistryRepo.git',
  );
  git(repoRoot, 'worktree', 'add', '-b', 'scope-worker', worktreeRoot);

  const legacyRepositoryId = digest('remote:github.com/example/registryrepo').slice(0, 24);
  const expectedProjectId = digest('project:' + legacyRepositoryId).slice(0, 24);

  const primary = await resolveRepositoryIdentity(repoRoot);
  const secondary = await resolveRepositoryIdentity(worktreeRoot);
  assert.equal(primary.repositoryId, legacyRepositoryId);
  assert.equal(secondary.repositoryId, legacyRepositoryId);
  assert.equal(primary.display, 'github.com/example/registryrepo');
  assert.equal(secondary.display, primary.display);
  assert.ok(!JSON.stringify(primary).includes('ghp_secret_should_not_leak'));
  assert.ok(!JSON.stringify(primary).includes('token-user'));

  assert.equal(deriveProjectId(legacyRepositoryId), expectedProjectId);
  const project = await resolveProjectIdentity(worktreeRoot);
  assert.equal(project.projectId, expectedProjectId);
  assert.equal(project.projectIdSource, 'repository_derived');
  assert.equal(project.repository.repositoryId, legacyRepositoryId);

  const localRepo = path.join(tempDir, 'local-repo');
  const localWorktree = path.join(tempDir, 'local-worktree');
  await fs.mkdir(localRepo, { recursive: true });
  execFileSync('git', ['init', localRepo]);
  git(localRepo, 'config', 'user.email', 'scope-test@example.invalid');
  git(localRepo, 'config', 'user.name', 'Scope Identity Test');
  await fs.writeFile(path.join(localRepo, 'README.md'), '# Local scope identity\n');
  git(localRepo, 'add', '.');
  git(localRepo, 'commit', '-m', 'baseline');
  git(localRepo, 'worktree', 'add', '-b', 'local-worker', localWorktree);
  const commonDir = git(localRepo, 'rev-parse', '--git-common-dir');
  let canonical = await fs.realpath(path.resolve(localRepo, commonDir));
  if (process.platform === 'win32') canonical = canonical.toLowerCase();
  const expectedLocalId = digest('local:' + digest(canonical)).slice(0, 24);
  const localPrimary = await resolveRepositoryIdentity(localRepo);
  const localSecondary = await resolveRepositoryIdentity(localWorktree);
  assert.equal(localPrimary.repositoryId, expectedLocalId);
  assert.equal(localSecondary.repositoryId, expectedLocalId);
  assert.equal(localPrimary.display, 'local-repository');
  assert.deepEqual(SCOPE_KINDS, ['rdc', 'project', 'task', 'action']);
  for (const id of [primary.repositoryId, project.projectId]) {
    assert.match(id, /^[a-f0-9]{24}$/);
  }

  console.log('✅ Scope identity tests passed');
} finally {
  await fs.rm(tempDir, { recursive: true, force: true });
}
