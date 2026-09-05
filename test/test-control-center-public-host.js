import assert from 'node:assert/strict';
import http from 'node:http';

const publicContract = await import('@wonderwhy-er/desktop-commander/control-center-contract');
assert.strictEqual(
  typeof publicContract.startControlCenterHost,
  'function',
  'Task 2 requires a PUBLIC startControlCenterHost runtime export',
);
const { startControlCenterHost } = publicContract;

function request({ port, path = '/', method = 'GET', token, origin, host, body }) {
  return new Promise((resolve, reject) => {
    const headers = {};
    if (token) headers['X-DC-Control-Token'] = token;
    if (origin) headers.Origin = origin;
    if (host) headers.Host = host;
    if (body !== undefined) headers['Content-Type'] = 'application/json';
    const req = http.request({ hostname: '127.0.0.1', port, path, method, headers }, (res) => {
      const chunks = [];
      res.on('data', (chunk) => chunks.push(chunk));
      res.on('end', () => resolve({
        status: res.statusCode,
        headers: res.headers,
        text: Buffer.concat(chunks).toString('utf8'),
      }));
    });
    req.on('error', reject);    if (body !== undefined) req.write(body);
    req.end();
  });
}

async function expectStartupFailure(extensions, pattern) {
  await assert.rejects(
    () => startControlCenterHost({ port: 0, quiet: true, extensions }),
    pattern,
  );
}

const route = (apiPrefix, path, handle, requiredCapabilities) => ({
  method: 'POST',
  apiPrefix,
  path,
  ...(requiredCapabilities ? { requiredCapabilities } : {}),
  handle,
});
const ext = (id, apiPrefixes, routes, requiredCapabilities, ui) => ({
  id,
  apiPrefixes,
  routes,
  ...(requiredCapabilities ? { requiredCapabilities } : {}),
  ...(ui ? { ui } : {}),
});

await assert.rejects(() => startControlCenterHost({ host: '0.0.0.0', port: 0, quiet: true }), /loopback/i);

await expectStartupFailure([
  ext('reserved', ['/api/state'], []),
], /reserved|api\/state/i);await expectStartupFailure([
  ext('one', ['/api/example'], []),
  ext('two', ['/api/example/admin'], []),
], /overlap|collision|namespace/i);
await expectStartupFailure([
  ext('dup', ['/api/one'], []),
  ext('dup', ['/api/two'], []),
], /duplicate|extension id/i);
await expectStartupFailure([
  ext('wild', ['/api/wild'], [route('/api/wild', '/*', async () => ({ status: 200, body: {} }))]),
], /route|wildcard|path/i);
await expectStartupFailure([
  ext('wrong-prefix', ['/api/owned'], [route('/api/other', '/run', async () => ({ status: 200, body: {} }))]),
], /prefix|owned|route/i);

let calls = 0;
let bodyCalls = 0;
let routeCapabilityCalls = 0;
let snapshot = {
  source: 'prototype',
  tier: 'pro',
  capabilities: ['policy.config'],
};
const provider = {
  async getEntitlement() {
    return { ...snapshot, capabilities: [...snapshot.capabilities] };
  },
};
const protectedExtension = ext(
  'protected',
  ['/api/test'],
  [
    route('/api/test', '/run/:id', async (context) => {
      calls += 1;
      return {
        status: 200,
        body: {
          id: context.params.id,
          query: context.query,
          tier: context.entitlement.tier,
        },
      };
    }),
    route('/api/test', '/route-cap', async () => {
      routeCapabilityCalls += 1;
      return { status: 200, body: { ok: true } };
    }, ['approvals.local']),
    route('/api/test', '/body', async (context) => {
      const parsed = await context.readJsonBody();
      bodyCalls += 1;
      return { status: 200, body: parsed };
    }),
    route('/api/test', '/boom', async () => {
      throw new Error('PRIVATE_HANDLER_DETAIL');
    }),
  ],
  ['policy.config'],
  { viewId: 'protected-view', label: 'Protected', html: '<section id="protected-view"></section>' },
);

const running = await startControlCenterHost({
  port: 0,
  token: 'c3-test-token',
  quiet: true,
  entitlementProvider: provider,
  extensions: [protectedExtension],
});
try {
  const root = await request({ port: running.port });
  assert.strictEqual(root.status, 200);
  assert.match(root.headers['cache-control'] ?? '', /no-store/);
  assert.strictEqual(root.headers['x-frame-options'], 'DENY');
  assert.match(root.headers['content-security-policy'] ?? '', /frame-ancestors 'none'/);

  const invalidHost = await request({ port: running.port, path: '/api/state', host: 'evil.example' });
  assert.strictEqual(invalidHost.status, 400);

  const missingToken = await request({ port: running.port, path: '/api/state' });
  assert.strictEqual(missingToken.status, 403);

  const state = await request({ port: running.port, path: '/api/state', token: 'c3-test-token' });
  assert.strictEqual(state.status, 200);
  const stateBody = JSON.parse(state.text);
  assert.strictEqual(stateBody.entitlement.tier, 'pro');
  assert.deepStrictEqual(stateBody.activeExtensions, [
    { id: 'protected', viewId: 'protected-view', label: 'Protected' },
  ]);

  const allowed = await request({
    port: running.port,
    path: '/api/test/run/abc?tag=one&tag=two',
    method: 'POST',
    token: 'c3-test-token',
    origin: `http://127.0.0.1:${running.port}`,
  });
  assert.strictEqual(allowed.status, 200);
  assert.deepStrictEqual(JSON.parse(allowed.text), {
    id: 'abc', query: { tag: ['one', 'two'] }, tier: 'pro',
  });
  assert.strictEqual(calls, 1);
  const foreignOrigin = await request({
    port: running.port,
    path: '/api/test/run/nope',
    method: 'POST',
    token: 'c3-test-token',
    origin: 'https://evil.example',
  });
  assert.strictEqual(foreignOrigin.status, 403);
  assert.strictEqual(calls, 1, 'Foreign Origin must be rejected before handler execution');

  snapshot = { source: 'prototype', tier: 'pro', capabilities: [] };
  const downgraded = await request({
    port: running.port,
    path: '/api/test/run/nope',
    method: 'POST',
    token: 'c3-test-token',
    origin: `http://127.0.0.1:${running.port}`,
  });
  assert.strictEqual(downgraded.status, 404);
  assert.strictEqual(calls, 1, 'Capability downgrade must be checked before handler execution');

  snapshot = { source: 'prototype', tier: 'pro', capabilities: ['policy.config'] };
  const routeCapabilityDenied = await request({ port: running.port, path: '/api/test/route-cap', method: 'POST', token: 'c3-test-token', origin: `http://127.0.0.1:${running.port}` });
  assert.strictEqual(routeCapabilityDenied.status, 404);
  assert.strictEqual(routeCapabilityCalls, 0, 'Route-level capability must be checked before handler execution');

  snapshot = {
    source: 'prototype',
    tier: 'pro',
    capabilities: ['policy.config'],
    expiresAt: new Date(Date.now() - 60_000).toISOString(),
  };
  const expired = await request({
    port: running.port,
    path: '/api/test/run/nope',
    method: 'POST',
    token: 'c3-test-token',
    origin: `http://127.0.0.1:${running.port}`,
  });
  assert.strictEqual(expired.status, 404);
  assert.strictEqual(calls, 1, 'Expired entitlement must be rejected before handler execution');

  snapshot = { source: 'prototype', tier: 'pro', capabilities: ['policy.config'], expiresAt: 'not-a-date' };
  const malformedExpiry = await request({ port: running.port, path: '/api/test/run/nope', method: 'POST', token: 'c3-test-token', origin: `http://127.0.0.1:${running.port}` });
  assert.strictEqual(malformedExpiry.status, 404);
  assert.strictEqual(calls, 1, 'Malformed entitlement expiry must fail closed before handler execution');

  snapshot = { source: 'prototype', tier: 'pro', capabilities: ['policy.config'] };
  const hugeBody = JSON.stringify({ value: 'x'.repeat(9000) });
  const bounded = await request({
    port: running.port,
    path: '/api/test/body',
    method: 'POST',
    token: 'c3-test-token',
    origin: `http://127.0.0.1:${running.port}`,
    body: hugeBody,
  });
  assert.strictEqual(bounded.status, 400);
  assert.strictEqual(bodyCalls, 0, 'Oversized body must not reach post-parse side effects');
  assert.ok(!bounded.text.includes('PRIVATE_HANDLER_DETAIL'));

  const boom = await request({
    port: running.port,
    path: '/api/test/boom',
    method: 'POST',
    token: 'c3-test-token',
    origin: `http://127.0.0.1:${running.port}`,
  });
  assert.strictEqual(boom.status, 500);
  assert.deepStrictEqual(JSON.parse(boom.text), { error: 'Control Center request failed.' });
  assert.ok(!boom.text.includes('PRIVATE_HANDLER_DETAIL'));
} finally {
  await running.close();
}

console.log('Public Control Center host security tests passed');