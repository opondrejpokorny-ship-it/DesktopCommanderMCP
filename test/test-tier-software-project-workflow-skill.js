/**
 * RED -> GREEN contract test for the Software Project Workflow skill.
 */

import assert from 'node:assert';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const root = path.resolve(__dirname, '..');

const rootSkill = path.join(root, 'skills', 'software-project-workflow', 'SKILL.md');
const claudeSkill = path.join(
  root,
  'plugins',
  'claude',
  'skills',
  'software-project-workflow',
  'SKILL.md'
);
const cursorSkill = path.join(
  root,
  'plugins',
  'cursor',
  'skills',
  'software-project-workflow',
  'SKILL.md'
);

const [rootText, claudeText, cursorText] = await Promise.all([
  fs.readFile(rootSkill, 'utf8'),
  fs.readFile(claudeSkill, 'utf8'),
  fs.readFile(cursorSkill, 'utf8'),
]);

assert.strictEqual(
  claudeText,
  rootText,
  'Root skill and Claude plugin mirror must stay byte-for-byte identical'
);
assert.strictEqual(
  cursorText,
  rootText,
  'Root skill and Cursor plugin mirror must stay byte-for-byte identical'
);

for (const required of [
  'name: software-project-workflow',
  'Inspect',
  'Plan',
  'Implement',
  'Test',
  'Review',
  'Document',
  'estimated progress',
  'work-log.md',
  'checkpoint.md',
  'failed attempts',
  'Resume',
  'A skill is guidance, not authorization',
  'Never store secrets',
]) {
  assert.ok(
    rootText.includes(required),
    `Software Project Workflow skill is missing required contract text: ${required}`
  );
}

assert.match(
  rootText,
  /100%.*verification.*documentation/is,
  'Progress guidance must reserve 100% for verified and documented completion'
);

console.log('✅ Software Project Workflow skill contract passed');
