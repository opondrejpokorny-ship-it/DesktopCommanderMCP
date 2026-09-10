import assert from 'node:assert/strict';
import {
  CapabilityRegistry,
  FREE_CAPABILITIES,
} from '../dist/entitlements/capabilities.js';
import { FreeEntitlementProvider } from '../dist/entitlements/free-provider.js';

const freeProvider = new FreeEntitlementProvider();
const freeEntitlement = await freeProvider.getEntitlement();
assert.equal(freeEntitlement.tier, 'free');
assert.equal(freeEntitlement.source, 'free-default');
assert.deepEqual([...freeEntitlement.capabilities].sort(), [...FREE_CAPABILITIES].sort());
assert.equal(typeof freeProvider.setTier, 'undefined');

const freeRegistry = new CapabilityRegistry(freeEntitlement.capabilities);
assert.equal(freeRegistry.has('core.mcp'), true);
for (const paid of ['policy.filesystem', 'approvals.local', 'progress.eta', 'team.device_policy', 'audit.local']) {
  assert.equal(freeRegistry.has(paid), false, `Free must not grant ${paid}`);
  assert.throws(() => freeRegistry.require(paid), new RegExp(`capability.*${paid.replace('.', '\\.')}`, 'i'));
}

const attachedCommercial = new CapabilityRegistry(['core.mcp', 'policy.filesystem']);
assert.equal(attachedCommercial.has('policy.filesystem'), true,
  'Public contract must still support an explicitly attached Commercial capability set');
console.log('✅ Free entitlement and public capability contract tests passed');
