/**
 * RED -> GREEN coverage for direct filesystem mutation enforcement.
 */
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import {
  applyActiveWorkEnforcementGate,
} from '../dist/workflow/active-work-enforcement.js';
import {
  registerActiveWork,
  removeActiveWork,
} from '../dist/workflow/active-work-registry.js';

const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'dc-active-work-gate-'));
const repoA = path.join(tempDir, 'repo-a');
const repoB = path.join(tempDir, 'repo-b');
const stateRoot = path.join(tempDir, 'state');

function git(cwd, ...args) {
  return execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8' }).trim();
}

try {
  process.env.DESKTOP_COMMANDER_WORKFLOW_STATE_DIR = stateRoot;
  await fs.mkdir(path.join(repoA, 'src'), { recursive: true });
  execFileSync('git', ['init', repoA]);
  git(repoA, 'config', 'user.email', 'test@example.invalid');
  git(repoA, 'config', 'user.name', 'Active Work Gate Test');
  await fs.writeFile(path.join(repoA, 'src', 'existing.txt'), 'old');
  await fs.writeFile(path.join(repoA, 'README.md'), '# Gate\n');
  git(repoA, 'add', '.');
  git(repoA, 'commit', '-m', 'baseline');
  git(repoA, 'remote', 'add', 'origin', 'https://github.com/example/gate.git');
  git(repoA, 'worktree', 'add', '-b', 'worker-b', repoB);

  const noEntry = await applyActiveWorkEnforcementGate('write_file', {
    path: path.join(repoA, 'src', 'new.txt'),
    content: 'x',
  });
  assert.equal(noEntry.allowed, false);
  assert.match(noEntry.result?.content?.[0]?.text ?? '', /ACTIVE_WORK_REGISTRATION_REQUIRED/);

  const registered = await registerActiveWork({
    projectRoot: repoA,
    title: 'Filesystem mutation coverage',
    scope: 'Exercise all direct mutation tool path shapes',
    affectedAreas: ['src'],
  });
  assert.equal(registered.registered, true);

  const cases = [
    ['write_file', { path: path.join(repoA, 'src', 'write.txt'), content: 'x' }],
    ['edit_block', {
      file_path: path.join(repoA, 'src', 'existing.txt'),
      old_string: 'old',
      new_string: 'new',
    }],
    ['create_directory', { path: path.join(repoA, 'src', 'folder') }],
    ['write_pdf', { outputPath: path.join(repoA, 'src', 'output.pdf'), content: '# PDF' }],
    ['move_file', {
      source: path.join(repoA, 'src', 'existing.txt'),
      destination: path.join(repoA, 'src', 'moved.txt'),
    }],
  ];

  for (const [tool, args] of cases) {
    const result = await applyActiveWorkEnforcementGate(tool, args);
    assert.equal(result.allowed, true, tool + ' should be covered by registered src area');
  }

  const unrelated = await applyActiveWorkEnforcementGate('write_file', {
    path: path.join(tempDir, 'outside.txt'),
    content: 'outside',
  });
  assert.equal(unrelated.allowed, true, 'non-Git writes must remain unaffected');

  const wrongWorktree = await applyActiveWorkEnforcementGate('write_file', {
    path: path.join(repoB, 'src', 'other.txt'),
    content: 'other',
  });
  assert.equal(wrongWorktree.allowed, false);
  assert.match(
    wrongWorktree.result?.content?.[0]?.text ?? '',
    /ACTIVE_WORK_REGISTRATION_REQUIRED/,
  );

  const outOfScope = await applyActiveWorkEnforcementGate('write_file', {
    path: path.join(repoA, 'docs', 'not-covered.md'),
    content: 'no',
  });
  assert.equal(outOfScope.allowed, false);
  assert.match(
    outOfScope.result?.content?.[0]?.text ?? '',
    /ACTIVE_WORK_SCOPE_UPDATE_REQUIRED/,
  );

  await removeActiveWork({ projectRoot: repoA, entryId: registered.entry.id });

  console.log('✅ Active work enforcement gate tests passed');
} finally {
  delete process.env.DESKTOP_COMMANDER_WORKFLOW_STATE_DIR;
  await fs.rm(tempDir, { recursive: true, force: true });
}
