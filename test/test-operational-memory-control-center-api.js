/** RED -> GREEN coverage for the M6 read-only Control Center Memory API. */
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { startControlCenter } from '../dist/control-center/server.js';

const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'dc-memory-m6-api-'));
const stateRoot = path.join(tempDir, 'state');
const policyFile = path.join(tempDir, 'policy.json');
const auditFile = path.join(tempDir, 'audit.jsonl');
const envKeys = [
  'DESKTOP_COMMANDER_WORKFLOW_STATE_DIR',
  'DESKTOP_COMMANDER_POLICY_FILE',
  'DESKTOP_COMMANDER_AUDIT_FILE',
];
const oldEnv = Object.fromEntries(envKeys.map((key) => [key, process.env[key]]));
process.env.DESKTOP_COMMANDER_WORKFLOW_STATE_DIR = stateRoot;
process.env.DESKTOP_COMMANDER_POLICY_FILE = policyFile;
process.env.DESKTOP_COMMANDER_AUDIT_FILE = auditFile;

async function api(running, pathname, { method = 'GET', token = running.token } = {}) {
  const response = await fetch(new URL(pathname, running.url), {
    method,
    headers: { 'X-DC-Control-Token': token },
  });  const text = await response.text();
  return { response, text, json: text ? JSON.parse(text) : null };
}

function requestWithHost(running, hostHeader) {
  const target = new URL('/api/memory/overview', running.url);
  return new Promise((resolve, reject) => {
    const request = http.request({
      hostname: target.hostname,
      port: Number(target.port),
      path: target.pathname,
      method: 'GET',
      headers: {
        Host: hostHeader,
        'X-DC-Control-Token': running.token,
      },
    }, (response) => {
      response.resume();
      response.once('end', () => resolve(response.statusCode));
    });
    request.once('error', reject);
    request.end();
  });
}

function assertControlledError(result, status = 400) {
  assert.equal(result.response.status, status);
  assert.deepEqual(Object.keys(result.json ?? {}), ['error']);
  assert.ok(!result.text.includes(tempDir), 'API errors must not expose filesystem paths');
}
let controlCenter;
try {
  await fs.mkdir(stateRoot, { recursive: true });
  await fs.writeFile(policyFile, JSON.stringify({
    version: 1,
    tier: 'free',
    profile: 'safe_developer',
    rules: [],
  }), 'utf8');

  controlCenter = await startControlCenter({
    host: '127.0.0.1', port: 0, token: 'memory-api-test-token', quiet: true,
  });

  const denied = await fetch(new URL('/api/memory/overview', controlCenter.url));
  assert.equal(denied.status, 403, 'Memory API must require the Control Center token');
  assert.equal(await requestWithHost(controlCenter, 'example.invalid'), 400);

  const state = await api(controlCenter, '/api/state');
  assert.equal(state.response.status, 200);
  assert.ok(
    state.json.activeExtensions.some((entry) => entry.id === 'memory'),
    'Memory must be registered as an active PUBLIC extension for Free',
  );

  const overview = await api(controlCenter, '/api/memory/overview');
  assert.equal(overview.response.status, 200);
  assert.equal(overview.json.totalEvents, 0);
  assert.ok(overview.json.indexHealth);
  assert.ok(!overview.text.includes(tempDir));
  const groups = await api(controlCenter, '/api/memory/groups?scope=project&limit=50');
  assert.equal(groups.response.status, 200);
  assert.deepEqual(groups.json.items, []);
  assert.ok(groups.json.health);

  const filterOptions = await api(controlCenter, '/api/memory/filter-options');
  assert.equal(filterOptions.response.status, 200);
  assert.deepEqual(filterOptions.json.projects, []);
  assert.deepEqual(filterOptions.json.kinds, ['error', 'limit', 'lesson']);

  const events = await api(
    controlCenter,
    '/api/memory/groups/safe-fingerprint/events?scope=global&limit=50',
  );
  assert.equal(events.response.status, 200);
  assert.deepEqual(events.json.items, []);

  const post = await api(controlCenter, '/api/memory/overview', { method: 'POST' });
  assert.equal(post.response.status, 404, 'Memory API must remain GET-only');

  for (const pathname of [
    '/api/memory/groups?limit=201',
    '/api/memory/groups?limit=0',
    '/api/memory/groups?limit=1.5',
    '/api/memory/groups?scope=bogus',
    '/api/memory/groups?kind=bogus',
    '/api/memory/groups?from=not-a-date',
  ]) {
    assertControlledError(await api(controlCenter, pathname));
  }
  for (const pathname of [
    '/api/memory/groups?from=2026-09-06T12%3A00%3A00Z&to=2026-09-05T12%3A00%3A00Z',
    '/api/memory/groups?minOccurrences=0',
    '/api/memory/groups?cursor=not-a-valid-cursor',
    '/api/memory/groups?scope=project&scope=global',
    '/api/memory/groups?filesystemPath=C%3A%5Csecret',
    '/api/memory/overview?projectId=project-a',
    '/api/memory/filter-options?scope=global',
  ]) {
    assertControlledError(await api(controlCenter, pathname));
  }

  const injection = encodeURIComponent("' OR 1=1 --");
  assertControlledError(await api(
    controlCenter,
    `/api/memory/groups?reasonCode=${injection}`,
  ));
  assertControlledError(await api(
    controlCenter,
    `/api/memory/groups/${injection}/events?scope=global`,
  ));

  for (const pathname of [
    '/api/memory/groups/safe-fingerprint/events?scope=project',
    '/api/memory/groups/safe-fingerprint/events?scope=global&projectId=project-a',
    '/api/memory/groups/safe-fingerprint/events?scope=bogus',
    '/api/memory/groups/safe-fingerprint/events?scope=global&limit=201',
    '/api/memory/groups/safe-fingerprint/events?scope=global&cursor=not-a-valid-cursor',
  ]) {
    assertControlledError(await api(controlCenter, pathname));
  }
  const missing = await api(controlCenter, '/api/memory/not-a-route');
  assert.equal(missing.response.status, 404);
  assert.ok(!missing.text.includes(tempDir));

  console.log('✅ Operational Memory Control Center API tests passed');
} finally {
  if (controlCenter) await controlCenter.close();
  for (const key of envKeys) {
    if (oldEnv[key] === undefined) delete process.env[key];
    else process.env[key] = oldEnv[key];
  }
  await fs.rm(tempDir, { recursive: true, force: true });
}
