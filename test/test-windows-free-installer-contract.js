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
  'scripts/installer/download-file.cjs',
  'scripts/installer/runtime-instance.mjs',
  'scripts/installer/runtime-launcher.mjs',
  'scripts/installer/install-windows-free.ps1',
  'scripts/installer/uninstall-windows-free.ps1',
  'scripts/installer/windows-free-bootstrapper.cs',
  'test/installer/windows-free-installer-e2e.test.js',
  'test/installer/windows-free-runtime-native-deps.test.js',
  'test/test-windows-free-installer-archive-security.js',
  'test/test-windows-free-installer-download-redirect.js',
  'test/test-windows-free-runtime-instance.js',
];
for (const relative of required) await fs.access(path.join(root, relative));

const runtimeBuilder = await fs.readFile(path.join(root, 'scripts/installer/build-windows-free-runtime.cjs'), 'utf8');
assert.match(runtimeBuilder, /NODE_VERSION = '24\.19\.0'/);
assert.match(runtimeBuilder, /NODE_ARCHIVE_SHA256/);
assert.match(runtimeBuilder, /forbiddenInputs/);
assert.match(runtimeBuilder, /control-center-bundle-inputs\.json/);

const installScript = await fs.readFile(
  path.join(root, 'scripts', 'installer', 'install-windows-free.ps1'),
  'utf8',
);
assert.match(installScript, /\$retiredBackup = \$backup \+ '\.retired'/);
assert.match(
  installScript,
  /Move-Item -LiteralPath \$backup -Destination \$retiredBackup[\s\S]*\$transactionCommitted = \$true[\s\S]*Remove-Item -LiteralPath \$retiredBackup -Recurse -Force -ErrorAction Stop/,
  'repair must atomically retire the rollback authority before best-effort cleanup',
);
assert.match(
  installScript,
  /catch \{\s*\$originalError = \$_\s*if \(\$transactionCommitted\) \{\s*throw \$originalError/,
  'post-commit failures must never restore a retired or partially cleaned backup',
);

const workflow = await fs.readFile(
  path.join(root, '.github', 'workflows', 'windows-free-installer-ci.yml'),
  'utf8',
);
assert.match(
  workflow,
  /github\.event_name != 'pull_request'.*github\.event\.pull_request\.head\.repo\.full_name == github\.repository/s,
  'persistent self-hosted Windows runner must refuse fork PR code',
);

console.log('✅ Windows Free installer source contract is wired');
