import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const workflows = path.join(root, '.github', 'workflows');
const openCore = await fs.readFile(path.join(workflows, 'open-core-proof-ci.yml'), 'utf8');
const coreSafety = await fs.readFile(path.join(workflows, 'prototype-policy-ci.yml'), 'utf8');
const prototypeCi = await fs.readFile(path.join(workflows, 'prototype-ci.yml'), 'utf8');
const combined = openCore + '\n' + coreSafety + '\n' + prototypeCi;

for (const forbidden of [
  'test/test-open-core-boundaries.js',
  'test/test-tier-*.js',
  'test/integration/policy-*.js',
]) assert.ok(!combined.includes(forbidden), `Public CI must not invoke paid test surface: ${forbidden}`);

for (const required of [
  'test/test-r3-public-source-boundary.js',
  'test/test-open-core-extraction-boundary.js',
  'test/test-r3-public-docs-boundary.js',
  'test/test-r3-build-cleans-dist.js',
  'test/test-config-atomic-persistence.js',
  'test/test-control-center-contract-v1.js',
  'test/test-free-package-artifact.js',
]) assert.ok(openCore.includes(required), `Open Core CI missing ${required}`);

for (const required of ['test/test-project-workflow-coordinator.js', 'test/integration/active-work-enforcement.js', 'test/integration/progress-enforcement.js', 'test/integration/r3-commercial-hook-core-safety.js']) {
  assert.ok(coreSafety.includes(required), `Free core-safety CI missing ${required}`);
}
assert.match(coreSafety, /Checkout public Free\/shared tree[\s\S]{0,220}fetch-depth:\s*0/,
  'Free core-safety CI must fetch full history before diffing against origin/prototype/free-pro-team');

assert.match(prototypeCi, /run:\s*npm test/, 'Prototype CI must retain the broad public regression suite');
assert.ok(prototypeCi.includes('test/test-r3-public-ci-boundary.js'),
  'Prototype CI must explicitly verify the R3 public CI boundary after the dynamic public suite');

for (const removedPaidTest of [
  'test-tier-approval-store.js',
  'test-tier-audit-store.js',
  'test-tier-policy-engine.js',
  'test-tier-policy-runtime.js',
  'integration/policy-gate-write.js',
  'integration/policy-team-audit.js',
  'integration/policy-terminal-approval.js',
]) {
  const candidate = path.join(root, 'test', ...removedPaidTest.split('/'));
  await assert.rejects(fs.access(candidate), undefined,
    `Paid-only public test must remain physically absent: ${removedPaidTest}`);
}
console.log('✅ All public CI workflows enforce the Free/shared-core boundary');
