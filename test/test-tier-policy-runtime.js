/**
 * RED -> GREEN tests for persistent prototype policy configuration.
 */

import assert from 'node:assert';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  loadPolicyRuntimeConfig,
  preflightToolRequest,
} from '../dist/policy/policy-runtime.js';

const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'dc-policy-test-'));
const missingPath = path.join(tempDir, 'missing.json');
const policyPath = path.join(tempDir, 'policy.json');
const invalidPath = path.join(tempDir, 'invalid.json');

try {
  const missing = await loadPolicyRuntimeConfig(missingPath);
  assert.deepStrictEqual(
    missing,
    { version: 1, tier: 'free', rules: [] },
    'A missing policy file should preserve Free/upstream behavior'
  );

  await fs.writeFile(policyPath, JSON.stringify({
    version: 1,
    tier: 'pro',
    deviceId: 'developer-1',
    rules: [{
      id: 'protected-production-write',
      action: 'filesystem.write',
      resourcePrefix: '/projects/production',
      decision: 'require_approval'
    }]
  }));

  const loaded = await loadPolicyRuntimeConfig(policyPath);
  assert.strictEqual(loaded.tier, 'pro');
  assert.strictEqual(loaded.deviceId, 'developer-1');
  assert.strictEqual(loaded.rules.length, 1);

  const preflight = await preflightToolRequest(
    'write_file',
    { path: '/projects/production/app.ts', content: 'change' },
    policyPath
  );
  assert.strictEqual(preflight.decision, 'require_approval');
  assert.strictEqual(preflight.matchedRuleId, 'protected-production-write');

  await fs.writeFile(invalidPath, '{ broken json');
  await assert.rejects(
    () => loadPolicyRuntimeConfig(invalidPath),
    /Invalid Desktop Commander policy file/,
    'An existing but invalid policy must fail closed instead of silently becoming Free'
  );

  console.log('✅ Policy runtime tests passed');
} finally {
  await fs.rm(tempDir, { recursive: true, force: true });
}
