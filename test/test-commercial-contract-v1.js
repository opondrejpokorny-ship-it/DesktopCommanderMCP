import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const packageJson = JSON.parse(await fs.readFile(path.join(root, 'package.json'), 'utf8'));

assert.deepStrictEqual(
  packageJson.exports?.['./commercial-contract'],
  {
    types: './dist/commercial-contract.d.ts',
    import: './dist/commercial-contract.js',
  },
  'The public package must expose one explicit versioned Commercial attachment subpath',
);
assert.strictEqual(
  packageJson.exports?.['./*'],
  './*',
  'Adding the Commercial contract must preserve existing public deep-import compatibility',
);

const contract = await import('@wonderwhy-er/desktop-commander/commercial-contract');
assert.strictEqual(contract.COMMERCIAL_CONTRACT_VERSION, 1);
assert.deepStrictEqual(
  Object.keys(contract).sort(),
  ['COMMERCIAL_CONTRACT_VERSION', 'CapabilityRegistry', 'configureRuntimeServices'].sort(),
  'Runtime exports must stay on the approved C1 whitelist',
);

const declarations = await fs.readFile(path.join(root, 'dist', 'commercial-contract.d.ts'), 'utf8');
for (const required of [
  'EntitlementProvider',
  'EntitlementSnapshot',
  'CapabilityRegistry',
  'RuntimePolicyHook',
  'RuntimePolicyGateResult',
  'RuntimeServices',
  'configureRuntimeServices',
]) {
  assert.match(declarations, new RegExp(`\\b${required}\\b`), `Missing public contract symbol: ${required}`);
}
for (const forbidden of [
  'PrototypeEntitlementProvider',
  'ProjectId',
  'RepositoryId',
  'operational-memory',
  'control-center',
  '/policy/',
  '../policy/',
]) {
  assert.ok(!declarations.includes(forbidden), `Commercial contract must not expose ${forbidden}`);
}

console.log('✅ Commercial contract v1 export surface passed');
