import assert from 'node:assert';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { resolveNpmInvocation } = require('../scripts/npm-invocation.cjs');

function fakeExists(existing) {
  const normalized = new Set(existing.map((item) => path.win32.normalize(item).toLowerCase()));
  return (candidate) => normalized.has(path.win32.normalize(candidate).toLowerCase());
}

const args = ['install', 'pkg with spaces', 'x&y', '(group)', 'caret^value'];
const baseEnv = { PATH: 'C:\\Volta;C:\\Node', ComSpec: 'C:\\Windows\\System32\\cmd.exe' };

{
  const result = resolveNpmInvocation(args, {
    platform: 'win32', env: baseEnv, existsSync: fakeExists(['C:\\Volta\\npm.exe']), pathImpl: path.win32,
  });
  assert.equal(result.executable, 'C:\\Volta\\npm.exe');
  assert.deepStrictEqual(result.args, args);
  assert.equal(result.options?.windowsVerbatimArguments, undefined);
}
{
  const result = resolveNpmInvocation(args, {
    platform: 'win32', env: { PATH: 'C:\\Node', ComSpec: baseEnv.ComSpec },
    existsSync: fakeExists(['C:\\Node\\npm.cmd']), pathImpl: path.win32,
  });
  assert.equal(result.executable, baseEnv.ComSpec);
  assert.deepStrictEqual(result.args.slice(0, 3), ['/d', '/s', '/c']);
  assert.equal(result.options?.windowsVerbatimArguments, true);
}

{
  const result = resolveNpmInvocation(['pack'], {
    platform: 'win32', env: baseEnv,
    existsSync: fakeExists(['C:\\Volta\\npm.exe', 'C:\\Node\\npm.cmd']), pathImpl: path.win32,
  });
  assert.equal(result.executable, 'C:\\Volta\\npm.exe', 'earlier PATH entry must win');
}

assert.throws(() => resolveNpmInvocation(['pack'], {
  platform: 'win32', env: { PATH: 'C:\\Empty', ComSpec: baseEnv.ComSpec }, existsSync: () => false, pathImpl: path.win32,
}), /npm.*PATH|PATH.*npm/i);

if (process.platform === 'win32') {
  const fs = await import('node:fs/promises');
  const os = await import('node:os');
  const { execFileSync } = await import('node:child_process');
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'dc-npm-cmd-'));
  const capture = path.join(dir, 'capture.json');
  const script = path.join(dir, 'capture.cjs');
  const cmd = path.join(dir, 'npm.cmd');
  await fs.writeFile(script, `require('node:fs').writeFileSync(process.env.CAPTURE_FILE, JSON.stringify(process.argv.slice(2)))`);
  await fs.writeFile(cmd, `@echo off\r\n"${process.execPath}" "%~dp0capture.cjs" "%~1" "%~2" "%~3" "%~4" "%~5"\r\n`);
  try {
    const env = { ...process.env, PATH: dir };
    delete env.ComSpec;
    const invocation = resolveNpmInvocation(args, { env });
    execFileSync(invocation.executable, invocation.args, { env: { ...env, CAPTURE_FILE: capture }, ...invocation.options });
    assert.deepStrictEqual(JSON.parse(await fs.readFile(capture, 'utf8')), args);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
}
console.log('✅ npm invocation resolver tests passed');
