import assert from 'node:assert';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const contractPath = path.join(root, 'docs/tier-prototype/open-core-boundaries.json');
const contract = JSON.parse(await fs.readFile(contractPath, 'utf8'));

assert.strictEqual(contract.schemaVersion, 1, 'Boundary contract must be versioned');
assert.deepStrictEqual(
  contract.allowedDependencies.public,
  ['public'],
  'Public/shared code must depend only on public/shared code',
);
for (const owner of ['pro', 'team', 'demo']) {
  assert.ok(
    Array.isArray(contract.allowedDependencies[owner]),
    `Dependency policy must be explicit for ${owner}`,
  );
}

const normalize = (value) => value.replaceAll('\\', '/');
const sourceRoot = path.join(root, 'src');
async function walk(dir) {
  const output = [];
  for (const entry of await fs.readdir(dir, { withFileTypes: true })) {
    const absolute = path.join(dir, entry.name);
    if (entry.isDirectory()) output.push(...await walk(absolute));
    else if (entry.isFile() && entry.name.endsWith('.ts')) output.push(absolute);
  }
  return output;
}

function ownerFor(relative) {
  const matches = contract.ownershipRules.filter((rule) => {
    if (rule.kind === 'file') return relative === rule.path;
    return relative === rule.path || relative.startsWith(rule.path + '/');
  });
  matches.sort((a, b) => b.path.length - a.path.length);
  return matches[0]?.owner ?? contract.defaultOwner;
}

function resolveRelativeImport(fromFile, specifier) {
  if (!specifier.startsWith('.')) return null;
  const raw = path.resolve(path.dirname(fromFile), specifier);
  const candidates = raw.endsWith('.js')
    ? [raw.slice(0, -3) + '.ts', path.join(raw.slice(0, -3), 'index.ts')]
    : [raw + '.ts', path.join(raw, 'index.ts')];
  return candidates;
}
for (const rule of contract.ownershipRules) {
  const absolute = path.join(root, rule.path);
  assert.ok(
    await fs.stat(absolute).then(() => true, () => false),
    `Ownership rule must reference an existing path: ${rule.path}`,
  );
}

const files = await walk(sourceRoot);
const violations = [];
const importPattern = /(?:import|export)\s+(?:[^'";]+?\s+from\s+)?['"]([^'"]+)['"]|import\(\s*['"]([^'"]+)['"]\s*\)/g;

for (const file of files) {
  const relative = normalize(path.relative(root, file));
  const owner = ownerFor(relative);
  assert.ok(contract.allowedDependencies[owner], `Unknown owner ${owner} for ${relative}`);
  const source = await fs.readFile(file, 'utf8');
  for (const match of source.matchAll(importPattern)) {
    const specifier = match[1] ?? match[2];
    const candidates = resolveRelativeImport(file, specifier);
    if (!candidates) continue;
    let target = null;
    for (const candidate of candidates) {
      if (await fs.stat(candidate).then(() => true, () => false)) {
        target = candidate;
        break;
      }
    }
    if (!target || !target.startsWith(sourceRoot)) continue;
    const targetRelative = normalize(path.relative(root, target));
    const targetOwner = ownerFor(targetRelative);
    if (!contract.allowedDependencies[owner].includes(targetOwner)) {
      violations.push(`${relative} [${owner}] -> ${targetRelative} [${targetOwner}]`);
    }
  }
}
assert.deepStrictEqual(
  violations,
  [],
  'Open-core dependency boundary violations:\n' + violations.join('\n'),
);

for (const required of contract.requiredPublicContracts) {
  assert.strictEqual(
    ownerFor(required),
    'public',
    `Required public cross-repo contract must remain public: ${required}`,
  );
}

console.log(
  `✅ Open-core extraction boundary passed (${files.length} TypeScript files classified)`,
);

// Keep the versioned public attachment contract under the existing Open Core CI gate.
await import('./test-commercial-contract-v1.js');
