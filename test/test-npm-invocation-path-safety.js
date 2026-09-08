import assert from 'node:assert/strict';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { resolveNpmInvocation } = require('../scripts/npm-invocation.cjs');

function fakeExists(existing) {
  const normalized = new Set(existing.map((item) => path.win32.normalize(item).toLowerCase()));
  return (candidate) => normalized.has(path.win32.normalize(candidate).toLowerCase());
}

const entry = 'C:\\Program Files\\Nódé & Tools ^ % !';
const npmCli = path.win32.join(entry, 'node_modules', 'npm', 'bin', 'npm-cli.js');
const nodeExe = 'C:\\Node Runtime\\node.exe';
const args = ['pack', 'C:\\repo & práce | ^ % !\\package', '--json'];

{
  const result = resolveNpmInvocation(args, {
    platform: 'win32',
    processExecPath: nodeExe,
    env: { PATH: `  "${entry}"  ;C:\\Later` },
    pathImpl: path.win32,
    existsSync: fakeExists([path.win32.join(entry, 'npm.cmd'), npmCli]),
  });
  assert.equal(result.executable, nodeExe);
  assert.deepStrictEqual(result.args, [npmCli, ...args]);
}

{
  const exeEntry = 'C:\\Nódé Tools & Bin';
  const npmExe = path.win32.join(exeEntry, 'npm.exe');
  const result = resolveNpmInvocation(args, {
    platform: 'win32',
    env: { Path: `"${exeEntry}"` },
    pathImpl: path.win32,
    existsSync: fakeExists([npmExe]),
  });
  assert.equal(result.executable, npmExe);
  assert.deepStrictEqual(result.args, args);
}

console.log('✅ npm invocation quoted/Unicode/metacharacter PATH tests passed');
