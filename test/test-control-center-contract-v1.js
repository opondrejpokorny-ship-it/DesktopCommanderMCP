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
  'C3 must not change the frozen Commercial Contract v1 export',
);
assert.strictEqual(
  packageJson.exports?.['./*'],
  './*',
  'C3 must preserve existing public deep-import compatibility',
);
assert.deepStrictEqual(
  packageJson.exports?.['./control-center-contract'],
  {
    types: './dist/control-center-contract.d.ts',
    import: './dist/control-center-contract.js',
  },
  'The public package must expose the Control Center Contract v1 subpath',
);
const contract = await import('@wonderwhy-er/desktop-commander/control-center-contract');
assert.strictEqual(contract.CONTROL_CENTER_CONTRACT_VERSION, 1);
assert.deepStrictEqual(
  Object.keys(contract).sort(),
  ['CONTROL_CENTER_CONTRACT_VERSION', 'startControlCenterHost'].sort(),
  'Control Center Contract v1 runtime exports must stay on the final approved whitelist',
);

const declarations = await fs.readFile(
  path.join(root, 'dist', 'control-center-contract.d.ts'),
  'utf8',
);
for (const required of [
  'ControlCenterMethodV1',
  'ControlCenterJsonResponseV1',
  'ControlCenterRequestContextV1',
  'ControlCenterRouteV1',
  'ControlCenterUiContributionV1',
  'ControlCenterExtensionV1',
  'ControlCenterHostOptionsV1',
  'RunningControlCenterHostV1',
]) {
  assert.match(declarations, new RegExp(`\\b${required}\\b`), `Missing public type: ${required}`);
}
for (const forbidden of [
  'policy/',
  '../policy/',
  'approval-store',
  'audit-store',
  'prototype',
  'setPolicyTier',
  'ProjectId',
  'RepositoryId',
  'operational-memory',
]) {
  assert.ok(
    !declarations.includes(forbidden),
    `Control Center Contract v1 must not expose ${forbidden}`,
  );
}

console.log('✅ Control Center contract v1 export surface passed');
