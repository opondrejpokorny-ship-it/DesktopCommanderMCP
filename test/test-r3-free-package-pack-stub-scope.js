import assert from 'node:assert/strict';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(import.meta.url);
const { shouldStubNpmPack } = require('./helpers/stub-free-package-npm-pack.cjs');

assert.equal(typeof shouldStubNpmPack, 'function', 'pack stub must expose its exact-match predicate');

const packageDir = path.join(root, '.artifacts', 'free', 'package');
const artifactRoot = path.join(root, '.artifacts', 'free');
const exactArgs = ['pack', packageDir, '--json', '--pack-destination', artifactRoot];

assert.equal(shouldStubNpmPack('npm', exactArgs), true);
assert.equal(shouldStubNpmPack('npm.cmd', exactArgs), true);
assert.equal(shouldStubNpmPack('npm.cmd', ['pack', path.join(root, 'other'), '--json', '--pack-destination', artifactRoot]), false);
assert.equal(shouldStubNpmPack('npm.cmd', ['pack', packageDir, '--json', '--pack-destination', path.join(root, 'other')]), false);
assert.equal(shouldStubNpmPack('npm.cmd', [...exactArgs, '--dry-run']), false);
assert.equal(shouldStubNpmPack('node', exactArgs), false);

console.log('✅ R3 Free package npm-pack stub is exact-invocation scoped');
