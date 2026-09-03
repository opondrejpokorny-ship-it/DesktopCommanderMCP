/**
 * RED -> GREEN tests for tier-aware lifecycle progress reporting.
 */

import assert from 'node:assert';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildProgressReport } from '../dist/progress/progress-reporter.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const root = path.resolve(__dirname, '..');

const base = {
  percentRemaining: 40,
  currentPhase: 'verification',
  estimatedRemainingMinutes: 25,
};

const free = buildProgressReport(base, 'free');
assert.strictEqual(free.tier, 'free');
assert.strictEqual(free.percentRemaining, 40);
assert.strictEqual(free.percentComplete, 60);
assert.strictEqual(free.currentPhase, 'verification');
assert.ok(!('estimatedRemainingMinutes' in free), 'Free must not expose paid ETA');
assert.ok(!('estimatedRemainingText' in free), 'Free must not expose paid ETA text');
assert.doesNotMatch(free.message, /minute|hour|ETA|estimated time/i);

for (const tier of ['pro', 'team']) {
  const paid = buildProgressReport(base, tier);
  assert.strictEqual(paid.tier, tier);
  assert.strictEqual(paid.percentRemaining, 40);
  assert.strictEqual(paid.percentComplete, 60);
  assert.strictEqual(paid.estimatedRemainingMinutes, 25);
  assert.match(paid.estimatedRemainingText, /25 min/i);
  assert.match(paid.message, /40%.*remaining/i);
  assert.match(paid.message, /25 min/i);
}

const rounded = buildProgressReport({
  percentRemaining: 35,
  currentPhase: 'integration',
  estimatedRemainingMinutes: 82,
}, 'pro');
assert.strictEqual(rounded.estimatedRemainingText, 'about 1 h 20 min');

const complete = buildProgressReport({
  percentRemaining: 0,
  currentPhase: 'complete',
  estimatedRemainingMinutes: 0,
}, 'team');
assert.strictEqual(complete.percentComplete, 100);
assert.strictEqual(complete.estimatedRemainingText, 'complete');

const rootSkill = await fs.readFile(
  path.join(root, 'skills', 'software-project-workflow', 'SKILL.md'),
  'utf8'
);
const pluginSkill = await fs.readFile(
  path.join(root, 'plugins', 'claude', 'skills', 'software-project-workflow', 'SKILL.md'),
  'utf8'
);
const manifestTemplate = JSON.parse(
  await fs.readFile(path.join(root, 'manifest.template.json'), 'utf8')
);

assert.ok(
  manifestTemplate.tools.some((tool) => tool.name === 'report_task_progress'),
  'MCPB manifest template must expose report_task_progress'
);
assert.strictEqual(pluginSkill, rootSkill, 'Skill mirrors must remain byte-for-byte identical');
assert.match(rootSkill, /report_task_progress/);
assert.match(rootSkill, /Free.*percent/i);
assert.match(rootSkill, /Pro.*Team.*estimated.*time/is);
assert.match(rootSkill, /ETA.*approximate|estimated time.*approximate/is);

console.log('✅ Tier-aware progress reporting tests passed');
