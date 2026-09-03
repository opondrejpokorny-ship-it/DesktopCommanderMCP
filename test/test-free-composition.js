/**
 * RED -> GREEN proof that the Free composition can compile without importing
 * prototype/commercial policy implementation.
 */
import assert from 'node:assert';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const root = path.resolve(path.dirname(__filename), '..');
const configPath = path.join(root, 'tsconfig.free.json');

assert.ok(fs.existsSync(configPath), 'Free composition tsconfig must exist');

const tsc = path.join(root, 'node_modules', 'typescript', 'bin', 'tsc');
const run = spawnSync(
  process.execPath,
  [tsc, '-p', configPath, '--noEmit', '--listFiles'],
  { cwd: root, encoding: 'utf8' },
);

assert.strictEqual(
  run.status,
  0,
  'Free composition must typecheck:\n' + (run.stderr || run.stdout),
);

const normalized = run.stdout.replaceAll('\\', '/').toLowerCase();
assert.doesNotMatch(
  normalized,
  /\/src\/policy\//,
  'Free composition dependency graph must not include commercial policy source',
);
assert.doesNotMatch(
  normalized,
  /\/src\/prototype\//,
  'Free composition dependency graph must not include prototype entitlement adapters',
);

const serverSource = fs.readFileSync(path.join(root, 'src', 'server.ts'), 'utf8');
assert.doesNotMatch(
  serverSource,
  /from ['"]\.\/policy\//,
  'Shared server must not statically import commercial policy implementation',
);

console.log('✅ Free composition dependency proof passed');
