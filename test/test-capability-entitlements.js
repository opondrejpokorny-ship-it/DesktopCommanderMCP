/**
 * RED -> GREEN tests for the shared entitlement/capability boundary.
 */
import assert from 'node:assert';
import {
  CapabilityRegistry,
  FREE_CAPABILITIES,
} from '../dist/entitlements/capabilities.js';
import { FreeEntitlementProvider } from '../dist/entitlements/free-provider.js';
import { PrototypeEntitlementProvider } from '../dist/prototype/prototype-entitlement-provider.js';

const freeProvider = new FreeEntitlementProvider();
const freeEntitlement = await freeProvider.getEntitlement();
assert.strictEqual(freeEntitlement.tier, 'free');
assert.strictEqual(freeEntitlement.source, 'free-default');
assert.deepStrictEqual([...freeEntitlement.capabilities].sort(), [...FREE_CAPABILITIES].sort());
assert.strictEqual(typeof freeProvider.setTier, 'undefined');

const freeRegistry = new CapabilityRegistry(freeEntitlement.capabilities);
assert.strictEqual(freeRegistry.has('core.mcp'), true);
assert.strictEqual(freeRegistry.has('policy.filesystem'), false);
assert.strictEqual(freeRegistry.has('progress.eta'), false);
assert.throws(
  () => freeRegistry.require('policy.filesystem'),
  /capability.*policy\.filesystem.*not available/i,
);

for (const [tier, expected] of [
  ['free', {
    policy: false,
    eta: false,
    teamDevice: false,
    audit: false,
  }],
  ['pro', {
    policy: true,
    eta: true,
    teamDevice: false,
    audit: false,
  }],
  ['team', {
    policy: true,
    eta: true,
    teamDevice: true,
    audit: true,
  }],
]) {
  const provider = new PrototypeEntitlementProvider(async () => ({
    version: 1,
    tier,
    rules: [],
  }));
  const entitlement = await provider.getEntitlement();
  const registry = new CapabilityRegistry(entitlement.capabilities);

  assert.strictEqual(entitlement.source, 'prototype');
  assert.strictEqual(entitlement.tier, tier);
  assert.strictEqual(registry.has('policy.filesystem'), expected.policy);
  assert.strictEqual(registry.has('policy.command'), expected.policy);
  assert.strictEqual(registry.has('approvals.local'), expected.policy);
  assert.strictEqual(registry.has('progress.eta'), expected.eta);
  assert.strictEqual(registry.has('team.device_policy'), expected.teamDevice);
  assert.strictEqual(registry.has('audit.local'), expected.audit);
}

console.log('✅ Entitlement/capability boundary tests passed');
