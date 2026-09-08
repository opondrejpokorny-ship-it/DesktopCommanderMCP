import assert from 'node:assert/strict';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { resolveNpmInvocation } = require('../scripts/npm-invocation.cjs');

function fakeExists(existing) {
  const normalized = new Set(existing.map((item) => path.win32.normalize(item).toLowerCase()));
  return (candidate) => normalized.has(path.win32.normalize(candidate).toLowerCase());
}

const args = ['pack', 'C:\\repo with spaces\\package', '--json'];
const nodeExe = 'C:\\Node Runtime\\node.exe';
const cliA = 'C:\\First\\node_modules\\npm\\bin\\npm-cli.js';
const cliB = 'C:\\Second\\node_modules\\npm\\bin\\npm-cli.js';

assert.deepStrictEqual(
  resolveNpmInvocation(args, { platform: 'linux' }),
  { executable: 'npm', args },
);

{
  const result = resolveNpmInvocation(args, {
    platform: 'win32', processExecPath: nodeExe,
    env: { PATH: 'C:\\First;C:\\Second' }, pathImpl: path.win32,
    existsSync: fakeExists(['C:\\First\\npm.exe', cliA, 'C:\\Second\\npm.exe', cliB]),
  });
  assert.equal(result.executable, 'C:\\First\\npm.exe');
  assert.deepStrictEqual(result.args, args);
}

{
  const result = resolveNpmInvocation(args, {
    platform: 'win32', processExecPath: nodeExe,
    env: { PATH: 'C:\\First;C:\\Second' }, pathImpl: path.win32,
    existsSync: fakeExists(['C:\\First\\npm.cmd', cliA, 'C:\\Second\\npm.exe']),
  });
  assert.equal(result.executable, nodeExe, 'earlier PATH entry must win without shelling through npm.cmd');
  assert.deepStrictEqual(result.args, [cliA, ...args]);
}

{
  const result = resolveNpmInvocation(args, {
    platform: 'win32', processExecPath: nodeExe,
    env: { PATH: 'C:\\First' }, pathImpl: path.win32,
    existsSync: fakeExists(['C:\\First\\npm.cmd', cliA]),
  });
  assert.equal(result.executable, nodeExe);
  assert.deepStrictEqual(result.args, [cliA, ...args]);
}

assert.throws(() => resolveNpmInvocation(args, {
  platform: 'win32', processExecPath: nodeExe,
  env: { PATH: 'C:\\OnlyCmd' }, pathImpl: path.win32,
  existsSync: fakeExists(['C:\\OnlyCmd\\npm.cmd']),
}), /npm.*cli|safe.*npm|npm.*PATH/i);

assert.throws(() => resolveNpmInvocation(args, {
  platform: 'win32', processExecPath: nodeExe,
  env: { PATH: 'C:\\First;C:\\Second' }, pathImpl: path.win32,
  existsSync: fakeExists(['C:\\First\\npm.cmd', 'C:\\Second\\npm.exe']),
}), /npm.*cli|safe.*npm/i, 'unsafe earlier npm.cmd must not be bypassed by a later npm.exe');

console.log('✅ npm invocation resolver tests passed');
