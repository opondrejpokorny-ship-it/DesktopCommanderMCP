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
    (await preflightToolRequest(
      'write_file',
      { path: path.join(projectPath, 'app.ts'), content: 'change' },
      policyFile
    )).decision,
    'allow',
    'Device-specific folder rule should override global rule on that device'
  );

  await setPolicyDeviceId('device-b', policyFile);

  assert.strictEqual(
    (await preflightToolRequest(
      'write_file',
      { path: path.join(projectPath, 'app.ts'), content: 'change' },
      policyFile
    )).decision,
    'deny',
    'Other devices should fall back to the global folder rule'
  );

  await setCommandPermission('git push', 'blocked', policyFile);
  await setCommandPermission('git push', 'allow', policyFile, 'device-a');

  await setPolicyDeviceId('device-a', policyFile);
  assert.strictEqual(
    (await preflightToolRequest(
      'start_process',
      { command: 'git push origin main', timeout_ms: 5000 },
      policyFile
    )).decision,
    'allow',
    'Device-specific command rule should override global rule'
  );

  await setPolicyDeviceId('device-b', policyFile);
  assert.strictEqual(
    (await preflightToolRequest(
      'start_process',
      { command: 'git push origin main', timeout_ms: 5000 },
      policyFile
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

  console.log('✅ Device-scoped Team policy tests passed');
} finally {
  await fs.rm(tempDir, { recursive: true, force: true });
}
