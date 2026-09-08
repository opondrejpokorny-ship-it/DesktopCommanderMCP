#!/usr/bin/env node
import fs from 'node:fs/promises';
import path from 'node:path';
import {
  publishNewBenchmarkFiles,
  readActiveVariant,
  resetFixture,
  selectVariant,
  validateManifest,
  verifyVariant,
  runtimeDigest,
} from './lib.mjs';

function getOption(args, name, required = true) {
  const index = args.indexOf(name);
  const value = index >= 0 ? args[index + 1] : undefined;
  if (required && !value) throw new Error(`${name} is required`);
  return value;
}

function parseRoot(args) {
  return path.resolve(getOption(args, '--root'));
}

async function loadManifest(root) {
  const manifest = validateManifest(JSON.parse(await fs.readFile(path.join(root, 'manifest.json'), 'utf8')));
  if (path.resolve(manifest.benchmarkRoot) !== root) {
    throw new Error('Manifest benchmark root does not match requested root');
  }
  return manifest;
}
async function initManifest(root, args) {
  const manifestPath = path.join(root, 'manifest.json');
  const activePath = path.join(root, 'active-variant.txt');
  for (const target of [manifestPath, activePath]) {
    try {
      await fs.access(target);
      throw new Error(`benchmark initialization target already exists: ${target}`);
    } catch (error) {
      if (error?.message?.includes('already exists')) throw error;
    }
  }
  const latest = getOption(args, '--upstream-latest');
  if (!/^[0-9a-f]{40}$/i.test(latest)) throw new Error('--upstream-latest must be a full Git SHA');
  const cleanRepo = path.resolve(getOption(args, '--clean-repo'));
  const prototypeRepo = path.resolve(getOption(args, '--prototype-repo'));
  for (const [label, repo] of [['clean', cleanRepo], ['prototype', prototypeRepo]]) {
    const [canonicalRoot, canonicalRepo] = await Promise.all([fs.realpath(root), fs.realpath(repo)]);
    const relative = path.relative(canonicalRoot, canonicalRepo);
    if (!relative || relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
      throw new Error(`${label} repoPath real path must stay within benchmark root`);
    }
  }
  const manifest = validateManifest({
    schemaVersion: 1,
    benchmarkRoot: root,
    upstreamLatestObserved: latest.toLowerCase(),
    variants: {
      clean: {
        repoPath: cleanRepo,
        expectedSha: getOption(args, '--clean-sha').toLowerCase(),
        runtimeDigest: await runtimeDigest(cleanRepo),
      },
      prototype: {
        repoPath: prototypeRepo,
        expectedSha: getOption(args, '--prototype-sha').toLowerCase(),
        runtimeDigest: await runtimeDigest(prototypeRepo),
      },
    },
  });
  await verifyVariant(manifest, 'clean');
  await verifyVariant(manifest, 'prototype');
  await publishNewBenchmarkFiles(root, `${JSON.stringify(manifest, null, 2)}\n`, 'prototype\n');
  return manifest;
}

async function main() {
  const args = process.argv.slice(2);
  const command = args[0];
  const root = parseRoot(args);
  if (command === 'init-manifest') {
    const result = await initManifest(root, args);
    process.stdout.write(`${JSON.stringify(result)}\n`);
    return;
  }
  if (command === 'reset-fixture') {
    const workspace = await resetFixture(root, args[1], args[2]);
    process.stdout.write(`${JSON.stringify({ workspace })}\n`);
    return;
  }
  if (command === 'select') {
    const result = await selectVariant(root, args[1]);
    process.stdout.write(`${JSON.stringify(result)}\n`);
    return;
  }
  if (command === 'verify') {
    const manifest = await loadManifest(root);
    const result = await verifyVariant(manifest, args[1]);
    process.stdout.write(`${JSON.stringify(result)}\n`);
    return;
  }
  if (command === 'status') {
    const manifest = await loadManifest(root);
    const selected = await readActiveVariant(root);
    const clean = await verifyVariant(manifest, 'clean');
    const prototype = await verifyVariant(manifest, 'prototype');
    process.stdout.write(`${JSON.stringify({ selected, clean, prototype })}\n`);
    return;
  }
  throw new Error(`Unknown command: ${command ?? '<missing>'}`);
}

main().catch((error) => {
  process.stderr.write(`RDC A/B error: ${error.message}\n`);
  process.exitCode = 1;
});