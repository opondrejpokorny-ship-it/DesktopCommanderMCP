/**
 * RED -> GREEN tests for privacy-safe Remote Device identity discovery.
 */

import assert from 'node:assert';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { loadRemoteDeviceIdentity } from '../dist/policy/device-identity.js';

const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'dc-device-identity-'));
const configFile = path.join(tempDir, 'device.json');

try {
  await fs.writeFile(configFile, JSON.stringify({
    deviceId: 'device-123',
    session: {
      access_token: 'super-secret-access',
      refresh_token: 'super-secret-refresh',
    },
  }));

  const identity = await loadRemoteDeviceIdentity(configFile);
  assert.deepStrictEqual(identity, { deviceId: 'device-123' });

  const serialized = JSON.stringify(identity);
  assert.ok(!serialized.includes('super-secret-access'));
  assert.ok(!serialized.includes('super-secret-refresh'));

  await fs.writeFile(configFile, JSON.stringify({
    session: { access_token: 'still-secret' },
  }));

  assert.strictEqual(
    await loadRemoteDeviceIdentity(configFile),
    null,
    'Config without a valid device ID should not expose anything'
  );

  assert.strictEqual(
    await loadRemoteDeviceIdentity(path.join(tempDir, 'missing.json')),
    null,
    'Missing Remote Device config should be treated as not configured'
  );

  console.log('✅ Remote Device identity discovery tests passed');
} finally {
  await fs.rm(tempDir, { recursive: true, force: true });
}
