import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const policyExamples = await fs.readFile(path.join(root, 'docs', 'tier-prototype', 'POLICY_EXAMPLES.md'), 'utf8');

assert.match(policyExamples, /private Commercial/i, 'Policy guide must explicitly identify paid policy as private Commercial functionality');
for (const forbidden of [
  'DESKTOP_COMMANDER_POLICY_FILE',
  'DESKTOP_COMMANDER_APPROVAL_FILE',
  '~/.claude-server-commander/policy.json',
  '~/.claude-server-commander/approvals.json',
]) {
  assert.ok(!policyExamples.includes(forbidden), `Public policy guide must not advertise removed public runtime surface: ${forbidden}`);
}
assert.doesNotMatch(policyExamples, /A matching write is stopped before the underlying Desktop Commander handler runs/i,
  'Public docs must not present private approval enforcement as a Free/public runtime guarantee');

const roadmap = await fs.readFile(path.join(root, 'docs', 'tier-prototype', 'ROADMAP.md'), 'utf8');
assert.match(roadmap, /Phases 0–9 below are historical pre-R3\.5 prototype records/i,
  'Roadmap must label the old paid prototype phases as historical before Phase 0');
assert.doesNotMatch(roadmap, /the current prototype entitlement provider derives that capability/i,
  'Roadmap must not describe the removed public prototype entitlement provider as current behavior');
assert.match(roadmap, /Historical pre-R3\.5 milestone/i,
  'Roadmap must clearly label the old public paid-prototype milestone as historical');
assert.doesNotMatch(roadmap, /The existing prototype entry point adds the entitlement\/policy adapter/i,
  'Roadmap must not describe the removed public paid adapter as current behavior');

console.log('✅ Public docs distinguish historical paid prototype behavior from current Free functionality');
