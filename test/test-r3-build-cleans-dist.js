import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const stale = path.join(root, 'dist', 'policy', 'r3-stale-paid-sentinel.js');
await fs.mkdir(path.dirname(stale), { recursive: true });
await fs.writeFile(stale, 'throw new Error("stale paid artifact");\n', 'utf8');

const command = process.platform === 'win32' ? (process.env.ComSpec ?? 'cmd.exe') : 'npm';
const args = process.platform === 'win32'
  ? ['/d', '/s', '/c', 'npm.cmd run build']
  : ['run', 'build'];
const run = spawnSync(command, args, { cwd: root, encoding: 'utf8' });
assert.equal(run.status, 0, `Build failed:\n${run.stderr || run.stdout}`);
assert.equal(await fs.stat(stale).then(() => true, () => false), false,
  'A normal public build must remove stale paid artifacts from a previous prototype build');
assert.equal(await fs.stat(path.join(root, 'dist', 'index.js')).then(() => true, () => false), true);
console.log('✅ Public build removes stale paid output');
