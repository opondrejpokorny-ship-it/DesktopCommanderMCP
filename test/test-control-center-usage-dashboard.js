import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { startControlCenter } from '../dist/control-center/server.js';

const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'dc-control-center-usage-'));
const usageFile = path.join(tempDir, 'usage.json');
const oldUsageFile = process.env.DESKTOP_COMMANDER_USAGE_FILE;
const periodStartedAt = '2026-09-07T08:00:00.000Z';
process.env.DESKTOP_COMMANDER_USAGE_FILE = usageFile;
await fs.writeFile(usageFile, JSON.stringify({
  returnedBytes: 58_452_062,
  writtenBytes: 9_720_225,
  periodStartedAt,
}, null, 2), 'utf8');

const running = await startControlCenter({
  port: 0,
  token: 'usage-dashboard-test-token',
  quiet: true,
});

try {
  const root = await fetch(running.url).then((response) => response.text());
  assert.match(root, /data-dc-target="usage"/, 'Control Center must expose a Usage navigation tab');
  assert.match(root, /data-dc-view="usage"/, 'Control Center must render a Usage view');
  assert.match(root, /Application payload only\./);
  assert.match(root, /Local disk I\/O and protocol\/WebSocket overhead are not counted\./);

  const response = await fetch(new URL('/api/usage/state', running.url), {
    headers: { 'X-DC-Control-Token': running.token },
  });
  assert.strictEqual(response.status, 200);
  assert.deepStrictEqual(await response.json(), {
    returnedBytes: 58_452_062,
    writtenBytes: 9_720_225,
    totalBytes: 68_172_287,
    periodStartedAt,
  });
} finally {
  await running.close();
  if (oldUsageFile === undefined) delete process.env.DESKTOP_COMMANDER_USAGE_FILE;
  else process.env.DESKTOP_COMMANDER_USAGE_FILE = oldUsageFile;
  await fs.rm(tempDir, { recursive: true, force: true });
}

console.log('Control Center usage dashboard tests passed');
