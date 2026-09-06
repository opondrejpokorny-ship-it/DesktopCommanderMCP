import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const buildScript = path.join(root, 'scripts', 'build-free-package.cjs');
const npmPackStub = path.join(root, 'test', 'helpers', 'stub-free-package-npm-pack.cjs');

execFileSync(process.execPath, ['--require', npmPackStub, buildScript], {
  cwd: root,
  stdio: 'inherit',
  env: {
    ...process.env,
    GIT_CONFIG_COUNT: '1',
    GIT_CONFIG_KEY_0: 'safe.directory',
    GIT_CONFIG_VALUE_0: root,
  },
});

const packageRoot = path.join(root, '.artifacts', 'free', 'package');
const packageJson = JSON.parse(await fs.readFile(path.join(packageRoot, 'package.json'), 'utf8'));
assert.deepStrictEqual(
  packageJson.exports['./commercial-contract'],
  {
    types: './dist/commercial-contract.d.ts',
    import: './dist/commercial-contract.js',
  },
  'The actual Free product package must expose Commercial Contract v1 for the separate private product',
);
for (const required of ['commercial-contract.js', 'commercial-contract.d.ts']) {
  await assert.doesNotReject(
    fs.stat(path.join(packageRoot, 'dist', required)),
    `The staged Free product must physically contain dist/${required}`,
  );
}

console.log('✅ R3 Free staged package exposes Commercial Contract v1');
