/**
 * RED -> GREEN contract tests for Scope B3 Project Profile resolution.
 */
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import {
  parseProjectProfile,
  resolveProjectProfile,
  tryResolveProjectProfile,
} from '../dist/workflow/project-profile.js';

const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'dc-project-profile-'));
const repoRoot = path.join(tempDir, 'repo');
const worktreeRoot = path.join(tempDir, 'repo-worktree');
const profileDir = path.join(repoRoot, '.desktop-commander');
const profilePath = path.join(profileDir, 'project-profile.json');

function git(cwd, ...args) {
  return execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8' }).trim();
}
function pathKey(value) {
  const normalized = path.normalize(value);
  return process.platform === 'win32' ? normalized.toLowerCase() : normalized;
}

const profile = {
  version: 1,
  name: 'Project Profile Test',
  instructions: [
    'Read authoritative project documentation before material work.',
    'Keep main as the clean upstream mirror.',
  ],
  definitionOfDone: 'The requested change is verified and integrated.',
  requiredPreRead: [
    { label: 'Roadmap', uri: 'https://docs.example.invalid/roadmap' },
    { label: 'Registry', uri: 'https://docs.example.invalid/registry' },
  ],
  repository: {
    authoritativeRepository: 'github.com/example/profilerepo',
    authoritativeBranch: 'prototype/free-pro-team',
    upstreamRepository: 'github.com/upstream/profilerepo',
    upstreamBranch: 'main',
  },
  workflowProfile: '.desktop-commander/project-workflow.json',
  verificationRequirements: [
    'Run focused tests and broader regression checks.',
    'Run git diff --check before integration.',
  ],
  deploymentRequirements: [
    'Deploy only with explicit user authorization.',
    'Verify live behavior after an authorized deployment.',
  ],
  graphify: {
    wrapper: 'scripts/graphify-local.cmd',
    mode: 'local_code_only',
  },
  documentation: [
    { label: 'Engineering Playbook', uri: 'https://docs.example.invalid/playbook' },
    { label: 'Owner Highlights', uri: 'https://docs.example.invalid/highlights' },
  ],
};

try {
  await fs.mkdir(profileDir, { recursive: true });
  await fs.writeFile(profilePath, JSON.stringify(profile, null, 2));
  await fs.writeFile(
    path.join(profileDir, 'project-workflow.json'),
    JSON.stringify({ version: 1, stages: [] }),
  );
  await fs.writeFile(path.join(repoRoot, 'README.md'), '# Project Profile Test\n');

  execFileSync('git', ['init', repoRoot]);
  git(repoRoot, 'config', 'user.email', 'profile-test@example.invalid');
  git(repoRoot, 'config', 'user.name', 'Project Profile Test');
  git(repoRoot, 'branch', '-M', 'prototype/free-pro-team');
  git(repoRoot, 'add', '.');
  git(repoRoot, 'commit', '-m', 'baseline');
  git(repoRoot, 'remote', 'add', 'origin', 'https://github.com/Example/ProfileRepo.git');
  git(repoRoot, 'worktree', 'add', '-b', 'profile-worker', worktreeRoot);

  const primary = await resolveProjectProfile(repoRoot);
  const secondary = await resolveProjectProfile(worktreeRoot);

  assert.equal(primary.identity.projectId, secondary.identity.projectId);
  assert.equal(
    primary.identity.repository.repositoryId,
    secondary.identity.repository.repositoryId,
  );
  assert.equal(primary.profile.name, profile.name);
  assert.deepEqual(primary.profile.instructions, profile.instructions);
  assert.deepEqual(primary.profile.requiredPreRead, profile.requiredPreRead);
  assert.equal(primary.profile.definitionOfDone, profile.definitionOfDone);
  assert.equal(primary.profile.workflowProfile, profile.workflowProfile);
  assert.deepEqual(primary.profile.repository, profile.repository);
  assert.deepEqual(primary.profile.graphify, profile.graphify);
  assert.deepEqual(primary.profile.documentation, profile.documentation);
  assert.match(primary.profileFingerprint, /^[a-f0-9]{64}$/);
  assert.equal(primary.repositoryMatches.authoritativeRepository, true);
  assert.equal(primary.repositoryMatches.authoritativeBranch, true);
  assert.equal(secondary.repositoryMatches.authoritativeRepository, true);
  assert.equal(secondary.repositoryMatches.authoritativeBranch, false);

  assert.equal(
    pathKey(primary.workflowProfilePath),
    pathKey(path.join(repoRoot, profile.workflowProfile)),
  );
  assert.equal(
    pathKey(primary.identity.repository.worktreeRoot),
    pathKey(await fs.realpath(repoRoot)),
  );
  assert.equal(
    pathKey(secondary.identity.repository.worktreeRoot),
    pathKey(await fs.realpath(worktreeRoot)),
  );

  assert.throws(
    () => parseProjectProfile({ ...profile, ignorePolicy: true }),
    /unknown project profile field.*ignorePolicy/i,
  );
  assert.throws(
    () => parseProjectProfile({ ...profile, projectId: '0123456789abcdef01234567' }),
    /unknown project profile field.*projectId/i,
  );
  assert.throws(
    () => parseProjectProfile({ ...profile, workflowProfile: '../project-workflow.json' }),
    /workflowProfile.*relative|workflowProfile.*project root/i,
  );
  assert.throws(
    () => parseProjectProfile({ ...profile, workflowProfile: 'C:\\outside\\workflow.json' }),
    /workflowProfile.*relative|workflowProfile.*project root/i,
  );
  assert.throws(
    () => parseProjectProfile({ ...profile, workflowProfile: '.desktop-commander/alternate-workflow.json' }),
    /workflowProfile.*project-workflow\.json|workflowProfile.*protected/i,
  );
  assert.throws(
    () => parseProjectProfile({ ...profile, version: 2 }),
    /version must be 1/i,
  );
  assert.throws(
    () => parseProjectProfile({
      ...profile,
      repository: {
        ...profile.repository,
        authoritativeRepository: 'https://github.com/example/profilerepo',
      },
    }),
    /authoritativeRepository.*host\/owner\/repository/i,
  );
  assert.throws(
    () => parseProjectProfile({ ...profile, instructions: Array(101).fill('instruction') }),
    /instructions.*100/i,
  );
  assert.throws(
    () => parseProjectProfile({ ...profile, name: 'x'.repeat(301) }),
    /name.*300|name.*too long/i,
  );

  const escapedRoot = path.join(tempDir, 'escaped-profile-repo');
  const escapedProfileDir = path.join(tempDir, 'external-profile');
  await fs.mkdir(escapedRoot, { recursive: true });
  await fs.mkdir(escapedProfileDir, { recursive: true });
  execFileSync('git', ['init', escapedRoot]);
  git(escapedRoot, 'config', 'user.email', 'profile-test@example.invalid');
  git(escapedRoot, 'config', 'user.name', 'Project Profile Test');
  await fs.writeFile(path.join(escapedRoot, 'README.md'), '# Escaped profile test\n');
  git(escapedRoot, 'add', '.');
  git(escapedRoot, 'commit', '-m', 'baseline');
  await fs.writeFile(
    path.join(escapedProfileDir, 'project-profile.json'),
    JSON.stringify({ ...profile, workflowProfile: 'README.md' }, null, 2),
  );
  await fs.symlink(
    escapedProfileDir,
    path.join(escapedRoot, '.desktop-commander'),
    process.platform === 'win32' ? 'junction' : 'dir',
  );
  await assert.rejects(
    () => resolveProjectProfile(escapedRoot),
    /Project Profile.*project root|profile.*within.*project root/i,
  );
  const missingRoot = path.join(tempDir, 'missing-profile-repo');
  await fs.mkdir(missingRoot, { recursive: true });
  execFileSync('git', ['init', missingRoot]);
  git(missingRoot, 'config', 'user.email', 'profile-test@example.invalid');
  git(missingRoot, 'config', 'user.name', 'Project Profile Test');
  await fs.writeFile(path.join(missingRoot, 'README.md'), '# No Project Profile\n');
  git(missingRoot, 'add', '.');
  git(missingRoot, 'commit', '-m', 'baseline');
  assert.equal(await tryResolveProjectProfile(missingRoot), undefined);
  await assert.rejects(
    () => resolveProjectProfile(missingRoot),
    /Project Profile not found/i,
  );

  console.log('✅ Project Profile tests passed');
} finally {
  await fs.rm(tempDir, { recursive: true, force: true });
}
