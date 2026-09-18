import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const pkg = JSON.parse(await fs.readFile(path.join(root, 'package.json'), 'utf8'));
assert.equal(pkg.scripts['build:windows-free-runtime'], 'node scripts/installer/build-windows-free-runtime.cjs');
assert.equal(pkg.scripts['build:windows-free-installer'], 'node scripts/installer/build-windows-free-installer.cjs');

const required = [
  'scripts/installer/build-windows-free-runtime.cjs',
  'scripts/installer/build-windows-free-installer.cjs',
  'scripts/installer/runtime-launcher.mjs',
  'scripts/installer/install-windows-free.ps1',
  'scripts/installer/uninstall-windows-free.ps1',
  'scripts/installer/windows-free-bootstrapper.cs',
  'test/installer/windows-free-installer-e2e.test.js',
  'test/installer/windows-free-runtime-native-deps.test.js',
  'test/test-windows-free-installer-archive-security.js',
];
for (const relative of required) await fs.access(path.join(root, relative));

const runtimeBuilder = await fs.readFile(path.join(root, 'scripts/installer/build-windows-free-runtime.cjs'), 'utf8');
assert.match(runtimeBuilder, /NODE_VERSION = '24\.19\.0'/);
assert.match(runtimeBuilder, /NODE_ARCHIVE_SHA256/);
assert.match(runtimeBuilder, /forbiddenInputs/);
assert.match(runtimeBuilder, /control-center-bundle-inputs\.json/);
console.log('✅ Windows Free installer source contract is wired');
