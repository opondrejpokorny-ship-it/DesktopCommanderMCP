/** RED -> GREEN proof for the privacy-safe Control Center Usage view. */
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { startControlCenter } from '../dist/control-center/server.js';
import { recordUsage } from '../dist/utils/usageMetering.js';

const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'dc-control-center-usage-'));
const usageFile = path.join(tempDir, 'usage-meter.json');
const policyFile = path.join(tempDir, 'policy.json');
const envKeys = ['DESKTOP_COMMANDER_USAGE_FILE', 'DESKTOP_COMMANDER_POLICY_FILE'];
const oldEnv = Object.fromEntries(envKeys.map((key) => [key, process.env[key]]));
process.env.DESKTOP_COMMANDER_USAGE_FILE = usageFile;
process.env.DESKTOP_COMMANDER_POLICY_FILE = policyFile;

async function api(running, pathname, token = running.token) {
  const response = await fetch(new URL(pathname, running.url), {
    headers: { 'X-DC-Control-Token': token },
  });
  const text = await response.text();
  return { response, text, json: text ? JSON.parse(text) : null };
}

let controlCenter;
try {
  await fs.writeFile(policyFile, JSON.stringify({
    version: 1, tier: 'free', profile: 'safe_developer', rules: [],
  }), 'utf8');
  const seeded = await recordUsage({ returnedBytes: 120, writtenBytes: 30 }, usageFile);
  controlCenter = await startControlCenter({
    host: '127.0.0.1', port: 0, token: 'usage-test-token', quiet: true,
  });

  const home = await fetch(controlCenter.url);
  assert.equal(home.status, 200);
  const html = await home.text();
  assert.match(html, />Usage</);
  assert.match(html, /data-dc-target="usage"/);
  assert.match(html, /data-dc-view="usage"/);
  assert.match(html, /id="usage-root"/);
  assert.match(html, /Total data usage/);
  assert.match(html, /Returned to AI/);
  assert.match(html, /Write\/edit payload to device/);
  assert.match(html, /Period started/);
  assert.match(html, /application payload/i);
  assert.match(html, /local disk I\/O/i);
  assert.match(html, /protocol\/WebSocket overhead/i);

  const state = await api(controlCenter, '/api/state');
  assert.equal(state.response.status, 200);
  assert.ok(
    state.json.activeExtensions.some((entry) => entry.id === 'usage'),
    'Usage must be available on the Free/shared Control Center surface',
  );

  const denied = await api(controlCenter, '/api/usage/state', 'wrong-token');
  assert.equal(denied.response.status, 403);

  const usage = await api(controlCenter, '/api/usage/state');
  assert.equal(usage.response.status, 200);
  assert.deepStrictEqual(usage.json, {
    totalBytes: 150,
    returnedBytes: 120,
    writtenBytes: 30,
    periodStartedAt: seeded.periodStartedAt,
  });
  assert.ok(!usage.text.includes(tempDir));

  await fs.rm(usageFile, { force: true });
  const empty = await api(controlCenter, '/api/usage/state');
  assert.deepStrictEqual(empty.json, {
    totalBytes: 0, returnedBytes: 0, writtenBytes: 0, periodStartedAt: null,
  });

  console.log('✅ Control Center Usage UI/API tests passed');
} finally {
  if (controlCenter) await controlCenter.close();
  for (const key of envKeys) {
    if (oldEnv[key] === undefined) delete process.env[key];
    else process.env[key] = oldEnv[key];
  }
  await fs.rm(tempDir, { recursive: true, force: true });
}
