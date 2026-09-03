/**
 * RED -> GREEN tests for Team device-scoped policy rules.
 */

import assert from 'node:assert';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  listCommandPermissions,
  listFolderPermissions,
  preflightToolRequest,
  setCommandPermission,
  setFolderPermission,
  setPolicyDeviceId,
} from '../dist/policy/policy-runtime.js';

const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'dc-device-scope-'));
const policyFile = path.join(tempDir, 'policy.json');
const projectPath = path.join(tempDir, 'projects');

async function preflightTeam(tool, args) {
  return preflightToolRequest(
    tool,
    args,
    policyFile,
    { allowDeviceScope: true }
  );
}

try {
  await fs.writeFile(policyFile, JSON.stringify({
    version: 1,
    tier: 'team',
    profile: 'full_access',
    deviceId: 'device-a',
    rules: [],
  }));

  await setFolderPermission(projectPath, 'blocked', policyFile);
  await setFolderPermission(projectPath, 'read_write', policyFile, 'device-a');

  assert.strictEqual(
    (await preflightTeam(
      'write_file',
      { path: path.join(projectPath, 'app.ts'), content: 'change' }
    )).decision,
    'allow',
    'Device-specific folder rule should override global rule on that device'
  );

  await setPolicyDeviceId('device-b', policyFile);

  assert.strictEqual(
    (await preflightTeam(
      'write_file',
      { path: path.join(projectPath, 'app.ts'), content: 'change' }
    )).decision,
    'deny',
    'Other devices should fall back to the global folder rule'
  );

  await setCommandPermission('git push', 'blocked', policyFile);
  await setCommandPermission('git push', 'allow', policyFile, 'device-a');

  await setPolicyDeviceId('device-a', policyFile);
  assert.strictEqual(
    (await preflightTeam(
      'start_process',
      { command: 'git push origin main', timeout_ms: 5000 }
    )).decision,
    'allow',
    'Device-specific command rule should override global rule'
  );

  await setPolicyDeviceId('device-b', policyFile);
  assert.strictEqual(
    (await preflightTeam(
      'start_process',
      { command: 'git push origin main', timeout_ms: 5000 }
    )).decision,
    'deny',
    'Other devices should keep the global command restriction'
  );

  const config = JSON.parse(await fs.readFile(policyFile, 'utf8'));
  assert.ok(
    listFolderPermissions(config).some(
      (entry) => entry.path === projectPath && entry.deviceId === 'device-a'
    )
  );
  assert.ok(
    listCommandPermissions(config).some(
      (entry) => entry.commandPrefix === 'git push' && entry.deviceId === 'device-a'
    )
  );

  // Team device scope is a capability, not a generic paid-tier behavior.
  // A Pro policy containing a device-specific allow must ignore that Team-only
  // rule and fall back to the global restriction.
  await fs.writeFile(policyFile, JSON.stringify({
    version: 1,
    tier: 'pro',
    profile: 'full_access',
    deviceId: 'device-a',
    rules: [
      {
        id: 'global-block',
        action: 'filesystem.write',
        resourcePrefix: projectPath,
        decision: 'deny',
      },
      {
        id: 'device-a-allow',
        action: 'filesystem.write',
        resourcePrefix: projectPath,
        deviceId: 'device-a',
        decision: 'allow',
      },
    ],
  }));

  assert.strictEqual(
    (await preflightToolRequest(
      'write_file',
      { path: path.join(projectPath, 'app.ts'), content: 'change' },
      policyFile
    )).decision,
    'deny',
    'Pro must not apply Team-only device-scoped policy rules without the capability'
  );

  console.log('✅ Device-scoped Team policy tests passed');
} finally {
  await fs.rm(tempDir, { recursive: true, force: true });
}
