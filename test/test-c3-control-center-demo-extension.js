import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { startControlCenterHost } from '../dist/control-center-contract.js';
import { PrototypeEntitlementProvider } from '../dist/prototype/prototype-entitlement-provider.js';

const sourceDir = new URL('../src/control-center/', import.meta.url);
const sourceNames = (await fs.readdir(sourceDir))
  .filter((name) => name.endsWith('.ts'));
const tierMutationImports = [];
for (const name of sourceNames) {
  const source = await fs.readFile(new URL(name, sourceDir), 'utf8');
  if (/\bsetPolicyTier\b/.test(source)) tierMutationImports.push(name);
}
assert.deepStrictEqual(
  tierMutationImports,
  ['demo-extension.ts'],
  'setPolicyTier must exist only in the demo-only Control Center extension',
);

const { createDemoControlCenterExtension } = await import(
  '../dist/control-center/demo-extension.js'
);
const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'dc-c3-demo-extension-'));
const policyFile = path.join(tempDir, 'policy.json');
const oldPolicyFile = process.env.DESKTOP_COMMANDER_POLICY_FILE;
process.env.DESKTOP_COMMANDER_POLICY_FILE = policyFile;
await fs.writeFile(policyFile, JSON.stringify({
  version: 1, tier: 'free', profile: 'full_access', rules: [],
}, null, 2), 'utf8');

async function post(running, pathname) {
  const response = await fetch(new URL(pathname, running.url), {
    method: 'POST',
    headers: {
      'X-DC-Control-Token': running.token,
      Origin: new URL(running.url).origin,
    },
  });
  const text = await response.text();
  return { status: response.status, json: text ? JSON.parse(text) : null };
}

const provider = new PrototypeEntitlementProvider();
const publicOnly = await startControlCenterHost({
  port: 0,
  token: 'c3-demo-public-only',
  quiet: true,
  entitlementProvider: provider,
  extensions: [],
});
try {
  const missing = await post(publicOnly, '/api/demo/tier/team');
  assert.strictEqual(missing.status, 404);
  const unchanged = JSON.parse(await fs.readFile(policyFile, 'utf8'));
  assert.strictEqual(unchanged.tier, 'free');
} finally {
  await publicOnly.close();
}

const extension = createDemoControlCenterExtension();
assert.strictEqual(extension.id, 'demo');
assert.deepStrictEqual(extension.apiPrefixes, ['/api/demo']);
assert.deepStrictEqual(extension.requiredCapabilities ?? [], []);
assert.ok(extension.ui, 'Demo extension must contribute the prototype tier selector');
assert.match(extension.ui.script ?? '', /\/api\/demo\/tier\//);
assert.ok(!(extension.ui.script ?? '').includes('/api/pro/'));
assert.ok(!(extension.ui.script ?? '').includes('/api/team/'));
assert.ok(!(extension.ui.script ?? '').includes('.innerHTML'));

const demo = await startControlCenterHost({
  port: 0,
  token: 'c3-demo-token',
  quiet: true,
  entitlementProvider: provider,
  extensions: [extension],
});
try {
  const before = await fetch(new URL('/api/state', demo.url), {
    headers: { 'X-DC-Control-Token': demo.token },
  }).then((response) => response.json());
  assert.strictEqual(before.entitlement.tier, 'free');

  const changed = await post(demo, '/api/demo/tier/team');
  assert.strictEqual(changed.status, 200);
  assert.deepStrictEqual(changed.json, { tier: 'team' });

  const persisted = JSON.parse(await fs.readFile(policyFile, 'utf8'));
  assert.strictEqual(persisted.tier, 'team');
  const after = await fetch(new URL('/api/state', demo.url), {
    headers: { 'X-DC-Control-Token': demo.token },
  }).then((response) => response.json());
  assert.strictEqual(after.entitlement.tier, 'team');

  const invalid = await post(demo, '/api/demo/tier/enterprise');
  assert.strictEqual(invalid.status, 400);
} finally {
  await demo.close();
  if (oldPolicyFile === undefined) delete process.env.DESKTOP_COMMANDER_POLICY_FILE;
  else process.env.DESKTOP_COMMANDER_POLICY_FILE = oldPolicyFile;
  await fs.rm(tempDir, { recursive: true, force: true });
}

console.log('C3 demo Control Center extension tests passed');
