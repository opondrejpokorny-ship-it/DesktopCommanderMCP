/**
 * RED -> GREEN tests for built-in policy profiles.
 */

import assert from 'node:assert';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  loadPolicyRuntimeConfig,
  preflightToolRequest,
} from '../dist/policy/policy-runtime.js';

const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'dc-policy-profile-test-'));

async function writePolicy(name, value) {
  const filePath = path.join(tempDir, name);
  await fs.writeFile(filePath, JSON.stringify(value));
  return filePath;
}

try {
  const safeDeveloper = await writePolicy('safe-developer.json', {
    version: 1,
    tier: 'pro',
    profile: 'safe_developer',
    rules: [],
  });

  assert.strictEqual(
    (await preflightToolRequest(
      'start_process',
      { command: 'npm test', timeout_ms: 5000 },
      safeDeveloper
    )).decision,
    'require_approval',
    'Safe Developer should require approval for terminal execution'
  );

  assert.strictEqual(
    (await preflightToolRequest(
      'set_config_value',
      { key: 'allowedDirectories', value: [] },
      safeDeveloper
    )).decision,
    'require_approval',
    'Safe Developer should require approval for config changes'
  );

  assert.strictEqual(
    (await preflightToolRequest(
      'write_file',
      { path: '/projects/app.ts', content: 'change' },
      safeDeveloper
    )).decision,
    'allow',
    'Safe Developer should keep normal file edits low-friction by default'
  );

  const readOnly = await writePolicy('read-only.json', {
    version: 1,
    tier: 'team',
    profile: 'read_only',
    rules: [],
  });

  assert.strictEqual(
    (await preflightToolRequest(
      'write_file',
      { path: '/projects/app.ts', content: 'change' },
      readOnly
    )).decision,
    'deny',
    'Read Only should deny file writes'
  );

  assert.strictEqual(
    (await preflightToolRequest(
      'start_process',
      { command: 'npm test', timeout_ms: 5000 },
      readOnly
    )).decision,
    'deny',
    'Read Only should deny terminal execution'
  );

  assert.strictEqual(
    (await preflightToolRequest(
      'read_file',
      { path: '/projects/app.ts' },
      readOnly
    )).decision,
    'allow',
    'Read Only should preserve reads'
  );

  const fullAccess = await writePolicy('full-access.json', {
    version: 1,
    tier: 'pro',
    profile: 'full_access',
    rules: [],
  });

  const fullAccessTerminal = await preflightToolRequest(
    'start_process',
    { command: 'npm test', timeout_ms: 5000 },
    fullAccess
  );
  assert.strictEqual(
    fullAccessTerminal.decision,
    'require_approval',
    'Full Access keeps broad filesystem access, but paid tiers still protect terminal execution'
  );
  assert.strictEqual(
    fullAccessTerminal.matchedRuleId,
    'tier:paid:terminal'
  );

  const safeWithOverride = await writePolicy('safe-override.json', {
    version: 1,
    tier: 'pro',
    profile: 'safe_developer',
    rules: [{
      id: 'allow-terminal-explicitly',
      action: 'terminal.execute',
      decision: 'allow',
    }],
  });

  assert.strictEqual(
    (await preflightToolRequest(
      'start_process',
      { command: 'npm test', timeout_ms: 5000 },
      safeWithOverride
    )).decision,
    'allow',
    'Explicit custom rules should take precedence over profile defaults'
  );

  const invalid = await writePolicy('invalid-profile.json', {
    version: 1,
    tier: 'pro',
    profile: 'definitely_not_a_profile',
    rules: [],
  });

  await assert.rejects(
    () => loadPolicyRuntimeConfig(invalid),
    /profile/i,
    'Unknown policy profiles should fail closed'
  );

  console.log('✅ Built-in policy profile tests passed');
} finally {
  await fs.rm(tempDir, { recursive: true, force: true });
}
