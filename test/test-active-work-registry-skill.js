/**
 * RED -> GREEN contract test for the Active Work Registry skill.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..');
const paths = [
  path.join(root, 'skills', 'active-work-registry', 'SKILL.md'),
  path.join(root, 'plugins', 'claude', 'skills', 'active-work-registry', 'SKILL.md'),
  path.join(root, 'plugins', 'cursor', 'skills', 'active-work-registry', 'SKILL.md'),
];

const texts = await Promise.all(paths.map((file) => fs.readFile(file, 'utf8')));
assert.equal(texts[1], texts[0], 'Claude skill mirror must match canonical skill');
assert.equal(texts[2], texts[0], 'Cursor skill mirror must match canonical skill');

for (const required of [
  'name: active-work-registry',
  'active_work_registry',
  'check',
  'register',
  'safe_parallel',
  'continue_existing',
  'wait_or_read_only',
  'Branch/worktree existence does NOT prove',
  'before editing',
  'remove',
  'authoritative target',
  'guidance, not authorization',
  'Never store secrets',
]) {
  assert.ok(
    texts[0].includes(required),
    'Active Work Registry skill is missing required contract text: ' + required,
  );
}

console.log('✅ Active Work Registry skill contract passed');
