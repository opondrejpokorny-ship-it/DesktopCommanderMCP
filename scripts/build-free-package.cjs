#!/usr/bin/env node
/**
 * Build a deliberately non-publishable Free proof package.
 *
 * This packages the same shared Desktop Commander runtime through src/free-index.ts
 * while omitting prototype/commercial policy, approvals, Control Center and Team
 * audit implementation from the emitted dependency graph and npm tarball.
 */
const fs = require('node:fs/promises');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const root = path.resolve(__dirname, '..');
const artifactRoot = path.join(root, '.artifacts', 'free');
const buildDir = path.join(artifactRoot, 'build');
const packageDir = path.join(artifactRoot, 'package');
const distDir = path.join(packageDir, 'dist');
const rootPackage = require(path.join(root, 'package.json'));

function command(name) {
  return process.platform === 'win32' ? name + '.cmd' : name;
}

function run(executable, args, options = {}) {
  return execFileSync(executable, args, {
    cwd: root,
    stdio: options.capture ? ['ignore', 'pipe', 'inherit'] : 'inherit',
    encoding: options.capture ? 'utf8' : undefined,
    env: { ...process.env, ...(options.env || {}) },
  });
}

async function copyIfExists(source, destination) {
  try {
    await fs.mkdir(path.dirname(destination), { recursive: true });
    await fs.copyFile(source, destination);
  } catch (error) {
    if (error && error.code === 'ENOENT') return;
    throw error;
  }
}

async function walk(dir, prefix = '') {
  const entries = await fs.readdir(dir, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    const relative = prefix ? prefix + '/' + entry.name : entry.name;
    const absolute = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      files.push(...await walk(absolute, relative));
    } else {
      files.push(relative);
    }
  }
  return files;
}

async function main() {
  await fs.rm(artifactRoot, { recursive: true, force: true });
  await fs.mkdir(buildDir, { recursive: true });

  const tsc = path.join(root, 'node_modules', 'typescript', 'bin', 'tsc');
  run(process.execPath, [tsc, '-p', 'tsconfig.free-package.json']);

  run(
    process.execPath,
    [path.join(root, 'scripts', 'build-ui-runtime.cjs')],
    { env: { DESKTOP_COMMANDER_UI_OUT_DIR: buildDir } },
  );

  await copyIfExists(
    path.join(root, 'src', 'data', 'onboarding-prompts.json'),
    path.join(buildDir, 'data', 'onboarding-prompts.json'),
  );
  await copyIfExists(
    path.join(root, 'src', 'remote-device', 'scripts', 'blocking-offline-update.js'),
    path.join(buildDir, 'remote-device', 'scripts', 'blocking-offline-update.js'),
  );

  await fs.mkdir(packageDir, { recursive: true });
  await fs.cp(buildDir, distDir, { recursive: true });

  const freeEntry = path.join(distDir, 'free-index.js');
  const packageEntry = path.join(distDir, 'index.js');
  await fs.rename(freeEntry, packageEntry);
  await fs.chmod(packageEntry, 0o755);

  const packageJson = {
    name: '@wonderwhy-er/desktop-commander-free-prototype',
    version: rootPackage.version + '-free-prototype.0',
    description: 'Presentation proof: Desktop Commander Free core without commercial capability implementation',
    private: true,
    type: 'module',
    license: rootPackage.license,
    author: rootPackage.author,
    engines: rootPackage.engines,
    bin: {
      'desktop-commander-free': 'dist/index.js',
    },
    dependencies: rootPackage.dependencies,
    optionalDependencies: rootPackage.optionalDependencies,
  };
  await fs.writeFile(
    path.join(packageDir, 'package.json'),
    JSON.stringify(packageJson, null, 2) + '\n',
    'utf8',
  );
  await copyIfExists(path.join(root, 'LICENSE'), path.join(packageDir, 'LICENSE'));

  const stagedFiles = await walk(packageDir);
  const normalized = stagedFiles.map((file) => file.replaceAll('\\', '/').toLowerCase());
  const forbidden = [
    'dist/policy/',
    'dist/prototype/',
    'dist/control-center/',
    'dist/npm-scripts/access-control.js',
  ];
  for (const prefix of forbidden) {
    if (normalized.some((file) => file.includes(prefix))) {
      throw new Error('Free package unexpectedly contains commercial path: ' + prefix);
    }
  }

  const packedRaw = run(
    command('npm'),
    ['pack', packageDir, '--json', '--pack-destination', artifactRoot],
    { capture: true },
  );
  const packed = JSON.parse(String(packedRaw));
  if (!Array.isArray(packed) || packed.length !== 1) {
    throw new Error('Unexpected npm pack output');
  }
  const pack = packed[0];
  const tarball = path.resolve(artifactRoot, pack.filename);
  const gitSha = (() => {
    try {
      return String(run('git', ['rev-parse', 'HEAD'], { capture: true })).trim();
    } catch {
      return null;
    }
  })();

  await fs.writeFile(
    path.join(artifactRoot, 'package-manifest.json'),
    JSON.stringify({
      kind: 'desktop-commander-free-presentation-proof',
      package: packageJson.name,
      version: packageJson.version,
      sourceSha: gitSha,
      tarball,
      files: pack.files,
      forbiddenCommercialPaths: forbidden,
    }, null, 2) + '\n',
    'utf8',
  );

  process.stdout.write(
    'Free package proof built: ' + tarball + '\n' +
    'Packaged files: ' + pack.files.length + '\n',
  );
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
