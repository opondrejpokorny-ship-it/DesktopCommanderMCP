#!/usr/bin/env node
const fs = require('node:fs/promises');
const fsSync = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const https = require('node:https');
const { execFileSync } = require('node:child_process');
const esbuild = require('esbuild');
const { resolveNpmInvocation } = require('../npm-invocation.cjs');

const root = path.resolve(__dirname, '..', '..');
const artifactRoot = path.join(root, '.artifacts', 'windows-free-runtime');
const runtimeRoot = path.join(artifactRoot, 'runtime');
const appRoot = path.join(runtimeRoot, 'app');
const cacheRoot = path.join(root, '.artifacts', 'windows-installer-cache');
const nodeExtractRoot = path.join(cacheRoot, 'node-extract');
const freeExtractRoot = path.join(artifactRoot, 'free-extract');
const runtimeZip = path.join(artifactRoot, 'runtime.zip');

const NODE_VERSION = '24.19.0';
const NODE_ARCHIVE = 'node-v' + NODE_VERSION + '-win-x64.zip';
const NODE_URL = 'https://nodejs.org/download/release/v' + NODE_VERSION + '/' + NODE_ARCHIVE;
const NODE_ARCHIVE_SHA256 = '57f71ab3652e797d84acddc79c81cc9ff1c6ddb2a1974cdb83f00fee9bff4c73';
const NODE_EXE_SHA256 = '3602f2bb1a10f2cbab4c36886218a33c1ab3db87290e73b033c46c77147d0237';

function run(executable, args, options = {}) {
  return execFileSync(executable, args, {
    cwd: options.cwd || root,
    stdio: options.capture ? ['ignore', 'pipe', 'inherit'] : 'inherit',
    encoding: options.capture ? 'utf8' : undefined,
    env: { ...process.env, ...(options.env || {}) },
    windowsHide: true,
  });
}

function runNpm(args, cwd) {
  const invocation = resolveNpmInvocation(args);
  return run(invocation.executable, invocation.args, { cwd });
}

async function sha256(filePath) {
  const hash = crypto.createHash('sha256');
  const stream = fsSync.createReadStream(filePath);
  for await (const chunk of stream) hash.update(chunk);
  return hash.digest('hex');
}

async function fileExists(filePath) {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

async function copyFile(source, destination) {
  await fs.mkdir(path.dirname(destination), { recursive: true });
  await fs.copyFile(source, destination);
}

async function download(url, destination, redirects = 5) {
  await fs.mkdir(path.dirname(destination), { recursive: true });
  const temp = destination + '.download-' + process.pid;
  await fs.rm(temp, { force: true });
  await new Promise((resolve, reject) => {
    const request = https.get(url, { headers: { 'User-Agent': 'DesktopCommanderInstallerBuilder/1' } }, (response) => {
      if (response.statusCode >= 300 && response.statusCode < 400 && response.headers.location && redirects > 0) {
        response.resume();
        fs.rm(temp, { force: true }).finally(() => {
          download(new URL(response.headers.location, url).toString(), destination, redirects - 1)
            .then(resolve, reject);
        });
        return;
      }
      if (response.statusCode !== 200) {
        response.resume();
        reject(new Error('Node runtime download failed with HTTP ' + response.statusCode));
        return;
      }
      const output = fsSync.createWriteStream(temp, { flags: 'wx' });
      response.pipe(output);
      output.on('finish', () => output.close(resolve));
      output.on('error', reject);
    });
    request.on('error', reject);
  });
  await fs.rename(temp, destination);
}

async function walkFiles(directory, prefix = '') {
  const entries = await fs.readdir(directory, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    const relative = prefix ? prefix + '/' + entry.name : entry.name;
    const absolute = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      files.push(...await walkFiles(absolute, relative));
    } else if (entry.isFile()) {
      files.push(relative.replaceAll('\\', '/'));
    }
  }
  return files;
}

async function prepareOfficialNode() {
  const nodeZipOverride = process.env.DESKTOP_COMMANDER_INSTALLER_NODE_ZIP;
  const nodeZip = nodeZipOverride
    ? path.resolve(nodeZipOverride)
    : path.join(cacheRoot, NODE_ARCHIVE);

  if (!nodeZipOverride) {
    const validCached = await fileExists(nodeZip) && await sha256(nodeZip) === NODE_ARCHIVE_SHA256;
    if (!validCached) {
      await fs.rm(nodeZip, { force: true });
      process.stdout.write('Downloading pinned Node runtime ' + NODE_VERSION + '...\n');
      await download(NODE_URL, nodeZip);
    }
  }
  const archiveHash = await sha256(nodeZip);
  if (archiveHash !== NODE_ARCHIVE_SHA256) {
    throw new Error('Pinned Node ZIP SHA-256 mismatch: ' + archiveHash);
  }

  await fs.rm(nodeExtractRoot, { recursive: true, force: true });
  await fs.mkdir(nodeExtractRoot, { recursive: true });
  run('tar.exe', ['-xf', nodeZip, '-C', nodeExtractRoot]);
  const extractedRoot = path.join(nodeExtractRoot, 'node-v' + NODE_VERSION + '-win-x64');
  const nodeExe = path.join(extractedRoot, 'node.exe');
  const nodeLicense = path.join(extractedRoot, 'LICENSE');
  if (await sha256(nodeExe) !== NODE_EXE_SHA256) {
    throw new Error('Pinned Node node.exe SHA-256 mismatch');
  }
  await copyFile(nodeExe, path.join(runtimeRoot, 'node.exe'));
  await copyFile(nodeLicense, path.join(runtimeRoot, 'NODE-LICENSE.txt'));
}

async function prepareDependencyClosure(rootPackage, rootLock) {
  const runtimePackage = {
    name: 'desktop-commander-free-runtime-dependencies',
    version: '1.0.0',
    private: true,
    license: rootPackage.license,
    engines: rootPackage.engines,
    dependencies: rootPackage.dependencies,
  };
  const runtimeLock = JSON.parse(JSON.stringify(rootLock));
  runtimeLock.name = runtimePackage.name;
  runtimeLock.version = runtimePackage.version;
  runtimeLock.packages[''] = {
    name: runtimePackage.name,
    version: runtimePackage.version,
    license: rootPackage.license,
    dependencies: rootPackage.dependencies,
    engines: rootPackage.engines,
  };
  await fs.mkdir(appRoot, { recursive: true });
  await fs.writeFile(path.join(appRoot, 'package.json'), JSON.stringify(runtimePackage, null, 2) + '\n');
  await fs.writeFile(path.join(appRoot, 'package-lock.json'), JSON.stringify(runtimeLock, null, 2) + '\n');
  runNpm(['ci', '--omit=dev', '--no-audit', '--no-fund'], appRoot);
}

async function installFreePackage(freeTarball) {
  await fs.rm(freeExtractRoot, { recursive: true, force: true });
  await fs.mkdir(freeExtractRoot, { recursive: true });
  run('tar.exe', ['-xzf', freeTarball, '-C', freeExtractRoot]);
  const sourcePackage = path.join(freeExtractRoot, 'package');
  const packageRoot = path.join(
    appRoot,
    'node_modules',
    '@wonderwhy-er',
    'desktop-commander-free-prototype',
  );
  await fs.rm(packageRoot, { recursive: true, force: true });
  await fs.mkdir(path.dirname(packageRoot), { recursive: true });
  await fs.cp(sourcePackage, packageRoot, { recursive: true });
  return packageRoot;
}

async function buildPublicControlCenterBundle() {
  const bundlePath = path.join(runtimeRoot, 'control-center-server.mjs');
  const result = await esbuild.build({
    entryPoints: [path.join(root, 'src', 'control-center', 'server.ts')],
    bundle: true,
    platform: 'node',
    format: 'esm',
    packages: 'external',
    target: 'node24',
    outfile: bundlePath,
    metafile: true,
    sourcemap: false,
    legalComments: 'none',
  });
  const inputs = Object.keys(result.metafile.inputs)
    .map((value) => value.replaceAll('\\', '/'))
    .sort();
  const forbiddenInputs = [
    '/src/policy/',
    '/src/prototype/',
    '/src/control-center/pro-extension.ts',
    '/src/control-center/team-extension.ts',
    '/src/control-center/demo-extension.ts',
    '/src/npm-scripts/access-control.ts',
  ];
  const forbiddenHit = inputs.find((input) =>
    forbiddenInputs.some((marker) => ('/' + input.toLowerCase()).includes(marker.toLowerCase())),
  );
  if (forbiddenHit) {
    throw new Error('Public Control Center bundle unexpectedly imports paid path: ' + forbiddenHit);
  }
  await fs.writeFile(
    path.join(runtimeRoot, 'control-center-bundle-inputs.json'),
    JSON.stringify({ inputs }, null, 2) + '\n',
    'utf8',
  );
  return inputs;
}

async function assertRuntimeBoundary(packageRoot) {
  const files = (await walkFiles(packageRoot)).map((value) => value.toLowerCase());
  const forbidden = [
    'dist/policy/',
    'dist/prototype/',
    'dist/control-center/pro-extension.js',
    'dist/control-center/team-extension.js',
    'dist/control-center/demo-extension.js',
    'dist/npm-scripts/access-control.js',
  ];
  for (const marker of forbidden) {
    if (files.some((file) => file.includes(marker))) {
      throw new Error('Windows Free runtime unexpectedly contains paid path: ' + marker);
    }
  }
  const required = [
    'dist/index.js',
    'dist/npm-scripts/remote.js',
    'dist/remote-device/device.js',
    'dist/remote-device/desktop-commander-integration.js',
  ];
  for (const requiredPath of required) {
    if (!files.includes(requiredPath)) {
      throw new Error('Windows Free runtime is missing required public path: ' + requiredPath);
    }
  }
}

async function criticalEntry(relativePath) {
  const absolute = path.join(runtimeRoot, ...relativePath.split('/'));
  return {
    path: relativePath,
    size: (await fs.stat(absolute)).size,
    sha256: await sha256(absolute),
  };
}

async function main() {
  if (process.platform !== 'win32' || process.arch !== 'x64') {
    throw new Error('Windows Free runtime builder requires Windows x64');
  }

  await fs.rm(artifactRoot, { recursive: true, force: true });
  await fs.mkdir(runtimeRoot, { recursive: true });
  await fs.mkdir(cacheRoot, { recursive: true });

  const rootPackage = JSON.parse(await fs.readFile(path.join(root, 'package.json'), 'utf8'));
  const rootLock = JSON.parse(await fs.readFile(path.join(root, 'package-lock.json'), 'utf8'));

  runNpm(['run', 'build'], root);
  run(process.execPath, [path.join(root, 'scripts', 'build-free-package.cjs')]);

  const freeManifestPath = path.join(root, '.artifacts', 'free', 'package-manifest.json');
  const freeManifest = JSON.parse(await fs.readFile(freeManifestPath, 'utf8'));
  const freeTarball = path.resolve(freeManifest.tarball);
  const freeTarballSha256 = await sha256(freeTarball);

  await prepareOfficialNode();
  await prepareDependencyClosure(rootPackage, rootLock);
  const packageRoot = await installFreePackage(freeTarball);
  await assertRuntimeBoundary(packageRoot);
  const controlCenterInputs = await buildPublicControlCenterBundle();

  await copyFile(
    path.join(root, 'scripts', 'installer', 'runtime-launcher.mjs'),
    path.join(runtimeRoot, 'launcher.mjs'),
  );
  await copyFile(
    path.join(root, 'scripts', 'installer', 'uninstall-windows-free.ps1'),
    path.join(runtimeRoot, 'uninstall.ps1'),
  );
  await copyFile(path.join(root, 'LICENSE'), path.join(runtimeRoot, 'LICENSE-DesktopCommander-MIT.txt'));

  const sourceSha = String(run('git', ['rev-parse', 'HEAD'], { capture: true })).trim();
  const notice = [
    'Desktop Commander Free Windows runtime v1',
    'Source SHA: ' + sourceSha,
    'Desktop Commander upstream license: MIT (see LICENSE-DesktopCommander-MIT.txt)',
    'Bundled Node.js: v' + NODE_VERSION + ' win-x64',
    'Node distribution license/notices: see NODE-LICENSE.txt',
    'This v1 artifact is unsigned and is not a production code-signing claim.',
    '',
  ].join('\r\n');
  await fs.writeFile(path.join(runtimeRoot, 'RUNTIME-NOTICE.txt'), notice, 'utf8');

  const packagePrefix = 'app/node_modules/@wonderwhy-er/desktop-commander-free-prototype/';
  const criticalPaths = [
    'node.exe',
    'launcher.mjs',
    'uninstall.ps1',
    'LICENSE-DesktopCommander-MIT.txt',
    'NODE-LICENSE.txt',
    'RUNTIME-NOTICE.txt',
    'app/package.json',
    'app/package-lock.json',
    packagePrefix + 'package.json',
    packagePrefix + 'dist/index.js',
    packagePrefix + 'dist/npm-scripts/remote.js',
    packagePrefix + 'dist/remote-device/device.js',
    packagePrefix + 'dist/remote-device/desktop-commander-integration.js',
    'control-center-server.mjs',
    'control-center-bundle-inputs.json',
  ];
  const criticalFiles = [];
  for (const relative of criticalPaths) criticalFiles.push(await criticalEntry(relative));

  const runtimeFiles = await walkFiles(runtimeRoot);
  const manifest = {
    kind: 'desktop-commander-windows-free-runtime-v1',
    sourceSha,
    sourcePackageVersion: rootPackage.version,
    freePackage: freeManifest.package,
    freePackageVersion: freeManifest.version,
    freeTarballSha256,
    node: {
      version: NODE_VERSION,
      archive: NODE_ARCHIVE,
      archiveSha256: NODE_ARCHIVE_SHA256,
      nodeExeSha256: NODE_EXE_SHA256,
      url: NODE_URL,
    },
    platform: 'win32',
    arch: 'x64',
    signed: false,
    controlCenterBundleInputs: controlCenterInputs,
    fileCountBeforeManifest: runtimeFiles.length,
    criticalFiles,
  };
  await fs.writeFile(
    path.join(runtimeRoot, 'runtime-manifest.json'),
    JSON.stringify(manifest, null, 2) + '\n',
    'utf8',
  );

  await fs.rm(runtimeZip, { force: true });
  run('tar.exe', ['-a', '-cf', runtimeZip, '-C', runtimeRoot, '.']);
  const runtimeZipSha256 = await sha256(runtimeZip);
  const buildManifest = {
    kind: 'desktop-commander-windows-free-runtime-build-v1',
    sourceSha,
    runtimeRoot,
    runtimeZip,
    runtimeZipSha256,
    nodeVersion: NODE_VERSION,
    freeTarballSha256,
    signed: false,
  };
  await fs.writeFile(
    path.join(artifactRoot, 'build-manifest.json'),
    JSON.stringify(buildManifest, null, 2) + '\n',
    'utf8',
  );

  process.stdout.write(
    'Windows Free runtime built: ' + runtimeZip + '\n' +
    'Runtime files: ' + (runtimeFiles.length + 1) + '\n' +
    'Runtime ZIP SHA-256: ' + runtimeZipSha256 + '\n',
  );
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
