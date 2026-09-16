import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const pkg = JSON.parse(await fs.readFile(path.join(root, 'package.json'), 'utf8'));

assert.equal(
  pkg.scripts['build:windows-free-runtime'],
  'node scripts/installer/build-windows-free-runtime.cjs',
  'Windows Free runtime must have a first-class reproducible build command',
);

const builder = path.join(root, 'scripts', 'installer', 'build-windows-free-runtime.cjs');
await fs.access(builder);

console.log('✅ Windows Free runtime build contract is wired');
