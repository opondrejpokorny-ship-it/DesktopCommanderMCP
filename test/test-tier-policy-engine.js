/**
 * RED -> GREEN tests for the prototype policy engine.
 *
 * The policy layer is intentionally additive: Free preserves upstream behavior,
 * while Pro/Team can return allow / deny / require_approval before the existing
 * Desktop Commander guardrails run.
 */

import assert from 'node:assert';
import { evaluatePolicy } from '../dist/policy/policy-engine.js';

function runTests() {
  const protectedWriteRule = {
    id: 'protected-write',
    action: 'filesystem.write',
    resourcePrefix: '/projects/production',
    decision: 'require_approval'
  };

  const blockedConfigRule = {
    id: 'blocked-config',
    action: 'config.change',
    decision: 'deny'
  };

  assert.strictEqual(
    evaluatePolicy(
      {
        tier: 'free',
        tool: 'write_file',
        action: 'filesystem.write',
        resource: '/projects/production/app.ts'
      },
      [protectedWriteRule]
    ).decision,
    'allow',
    'Free should preserve the existing low-friction Desktop Commander behavior'
  );

  assert.strictEqual(
    evaluatePolicy(
      {
        tier: 'pro',
        tool: 'write_file',
        action: 'filesystem.write',
        resource: '/projects/production/app.ts'
      },
      [protectedWriteRule]
    ).decision,
    'require_approval',
    'Pro should require approval for a matching protected write'
  );

  assert.strictEqual(
    evaluatePolicy(
      {
        tier: 'pro',
        tool: 'read_file',
        action: 'filesystem.read',
        resource: '/projects/production/app.ts'
      },
      [protectedWriteRule]
    ).decision,
    'allow',
    'A write-only rule must not block reads'
  );

  assert.strictEqual(
    evaluatePolicy(
      {
        tier: 'team',
        tool: 'set_config_value',
        action: 'config.change'
      },
      [blockedConfigRule]
    ).decision,
    'deny',
    'Team should be able to deny an explicitly blocked action'
  );

  assert.strictEqual(
    evaluatePolicy(
      {
        tier: 'pro',
        tool: 'start_process',
        action: 'terminal.execute',
        resource: 'npm test'
      },
      []
    ).decision,
    'allow',
    'Unmatched actions should remain allowed so existing upstream guardrails still decide'
  );

  console.log('✅ Prototype policy engine tests passed');
}

runTests();
