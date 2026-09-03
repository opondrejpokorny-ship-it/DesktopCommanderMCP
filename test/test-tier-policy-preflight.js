/**
 * RED -> GREEN tests for mapping real MCP tool requests into policy contexts.
 */

import assert from 'node:assert';
import { evaluateToolRequestPolicy } from '../dist/policy/tool-policy.js';

const protectedWrite = {
  id: 'production-write',
  action: 'filesystem.write',
  resourcePrefix: '/projects/production',
  decision: 'require_approval'
};

const deviceBlockedWrite = {
  id: 'server-write-block',
  action: 'filesystem.write',
  deviceId: 'server-1',
  decision: 'deny'
};

assert.strictEqual(
  evaluateToolRequestPolicy(
    'write_file',
    { path: '/projects/production/app.ts', content: 'change' },
    { tier: 'pro', rules: [protectedWrite] }
  ).decision,
  'require_approval',
  'write_file should normalize to filesystem.write using its path'
);

assert.strictEqual(
  evaluateToolRequestPolicy(
    'read_file',
    { path: '/projects/production/app.ts' },
    { tier: 'pro', rules: [protectedWrite] }
  ).decision,
  'allow',
  'read_file should not match a filesystem.write rule'
);

assert.strictEqual(
  evaluateToolRequestPolicy(
    'write_file',
    { path: '/projects/production/app.ts', content: 'change' },
    { tier: 'free', rules: [protectedWrite] }
  ).decision,
  'allow',
  'Free should preserve upstream behavior'
);

assert.strictEqual(
  evaluateToolRequestPolicy(
    'start_process',
    { command: 'npm test', timeout_ms: 5000 },
    {
      tier: 'pro',
      rules: [{
        id: 'terminal-approval',
        action: 'terminal.execute',
        decision: 'require_approval'
      }]
    }
  ).decision,
  'require_approval',
  'start_process should normalize to terminal.execute'
);

assert.strictEqual(
  evaluateToolRequestPolicy(
    'set_config_value',
    { key: 'allowedDirectories', value: [] },
    {
      tier: 'pro',
      rules: [{
        id: 'config-approval',
        action: 'config.change',
        decision: 'require_approval'
      }]
    }
  ).decision,
  'require_approval',
  'set_config_value should normalize to config.change'
);

assert.strictEqual(
  evaluateToolRequestPolicy(
    'write_file',
    { path: '/projects/app.ts', content: 'change' },
    { tier: 'team', deviceId: 'server-1', rules: [deviceBlockedWrite] }
  ).decision,
  'deny',
  'Team rules should be able to target a specific device'
);

assert.strictEqual(
  evaluateToolRequestPolicy(
    'write_file',
    { path: '/projects/app.ts', content: 'change' },
    { tier: 'team', deviceId: 'developer-1', rules: [deviceBlockedWrite] }
  ).decision,
  'allow',
  'A device-specific rule must not affect another device'
);

assert.strictEqual(
  evaluateToolRequestPolicy(
    'write_file',
    { path: '/projects/production-old/app.ts', content: 'change' },
    { tier: 'pro', rules: [protectedWrite] }
  ).decision,
  'allow',
  'Resource prefixes must respect path boundaries'
);

assert.strictEqual(
  evaluateToolRequestPolicy(
    'get_config',
    {},
    { tier: 'pro', rules: [] }
  ).decision,
  'allow',
  'Unmapped read-only tools should remain allowed'
);

console.log('✅ Tool policy normalization tests passed');
