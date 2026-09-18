#!/usr/bin/env node
const fs = require('node:fs/promises');
const fsSync = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { execFileSync } = require('node:child_process');

const root = path.resolve(__dirname, '..', '..');
const runtimeArtifactRoot = path.join(root, '.artifacts', 'windows-free-runtime');
const artifactRoot = path.join(root, '.artifacts', 'windows-free-installer');
const payloadRoot = path.join(artifactRoot, 'payload');
const setupPath = path.join(artifactRoot, 'DesktopCommanderFreeSetup.exe');

function run(executable, args, options = {}) {
  return execFileSync(executable, args, {
    cwd: options.cwd || root,
    stdio: options.capture ? ['ignore', 'pipe', 'inherit'] : 'inherit',
    encoding: options.capture ? 'utf8' : undefined,
    env: { ...process.env, ...(options.env || {}) },
    windowsHide: true,
  });
}

async function sha256(filePath) {
  const hash = crypto.createHash('sha256');
  const stream = fsSync.createReadStream(filePath);
  for await (const chunk of stream) hash.update(chunk);
  return hash.digest('hex');
}

async function copyFile(source, destination) {
  await fs.mkdir(path.dirname(destination), { recursive: true });
  await fs.copyFile(source, destination);
}

async function readJson(filePath) {
  return JSON.parse((await fs.readFile(filePath, 'utf8')).replace(/^\uFEFF/, ''));
}

async function main() {
  if (process.platform !== 'win32' || process.arch !== 'x64') {
    throw new Error('Windows Free installer builder requires Windows x64');
  }

  if (process.env.DESKTOP_COMMANDER_INSTALLER_REUSE_RUNTIME !== '1') {
    run(process.execPath, [path.join(root, 'scripts', 'installer', 'build-windows-free-runtime.cjs')]);
  }

  const runtimeZip = path.join(runtimeArtifactRoot, 'runtime.zip');
  const runtimeBuildManifestPath = path.join(runtimeArtifactRoot, 'build-manifest.json');
  const runtimeBuildManifest = await readJson(runtimeBuildManifestPath);
  const runtimeZipSha256 = await sha256(runtimeZip);
  if (runtimeBuildManifest.kind !== 'desktop-commander-windows-free-runtime-build-v1') {
    throw new Error('Unexpected Windows Free runtime build manifest kind');
  }
  if (runtimeBuildManifest.runtimeZipSha256 !== runtimeZipSha256) {
    throw new Error('Runtime ZIP does not match its build manifest SHA-256');
  }

  await fs.rm(artifactRoot, { recursive: true, force: true });
  await fs.mkdir(payloadRoot, { recursive: true });

  const payloadRuntimeZip = path.join(payloadRoot, 'runtime.zip');
  const payloadInstallScript = path.join(payloadRoot, 'install.ps1');
  const payloadManifestPath = path.join(payloadRoot, 'payload-manifest.json');

  await copyFile(runtimeZip, payloadRuntimeZip);
  await copyFile(
    path.join(root, 'scripts', 'installer', 'install-windows-free.ps1'),
    payloadInstallScript,
  );

  const sourceSha = String(run('git', ['rev-parse', 'HEAD'], { capture: true })).trim();
  const payloadManifest = {
    kind: 'desktop-commander-windows-free-installer-payload-v1',
    sourceSha,
    runtimeZipSha256,
    runtimeSourceSha: runtimeBuildManifest.sourceSha,
    signed: false,
  };
  await fs.writeFile(
    payloadManifestPath,
    JSON.stringify(payloadManifest, null, 2) + '\n',
    'utf8',
  );

  const windir = process.env.WINDIR || 'C:\\Windows';
  const cscCandidates = [
    path.join(windir, 'Microsoft.NET', 'Framework64', 'v4.0.30319', 'csc.exe'),
    path.join(windir, 'Microsoft.NET', 'Framework', 'v4.0.30319', 'csc.exe'),
  ];
  let csc = null;
  for (const candidate of cscCandidates) {
    try {
      await fs.access(candidate);
      csc = candidate;
      break;
    } catch {}
  }
  if (!csc) {
    throw new Error('Windows .NET Framework C# compiler was not found');
  }

  const bootstrapperSource = path.join(root, 'scripts', 'installer', 'windows-free-bootstrapper.cs');
  const winForms = path.join(
    windir,
    'Microsoft.NET',
    'Framework64',
    'v4.0.30319',
    'System.Windows.Forms.dll',
  );
  const winFormsFallback = path.join(
    windir,
    'Microsoft.NET',
    'Framework',
    'v4.0.30319',
    'System.Windows.Forms.dll',
  );
  const winFormsReference = fsSync.existsSync(winForms) ? winForms : winFormsFallback;

  const compileArgs = [
    '/nologo',
    '/target:winexe',
    '/optimize+',
    '/platform:x64',
    '/out:' + setupPath,
    '/reference:' + winFormsReference,
    '/resource:' + payloadRuntimeZip + ',DesktopCommander.RuntimeZip',
    '/resource:' + payloadInstallScript + ',DesktopCommander.InstallPs1',
    '/resource:' + payloadManifestPath + ',DesktopCommander.PayloadManifest',
    bootstrapperSource,
  ];

  try {
    run(csc, compileArgs);
  } catch (error) {
    throw new Error('C# bootstrapper compilation failed: ' + (error.message || String(error)));
  }

  const setupStat = await fs.stat(setupPath);
  if (!setupStat.isFile() || setupStat.size <= (await fs.stat(payloadRuntimeZip)).size) {
    throw new Error('C# bootstrapper did not create a plausible embedded Setup.exe');
  }

  const setupSha256 = await sha256(setupPath);
  const manifest = {
    kind: 'desktop-commander-windows-free-installer-v1',
    sourceSha,
    setupPath,
    setupSha256,
    setupBytes: setupStat.size,
    runtimeZipSha256,
    runtimeSourceSha: runtimeBuildManifest.sourceSha,
    signed: false,
    packaging: 'dotnet-framework-csharp-embedded-resources',
    compiler: csc,
  };
  await fs.writeFile(
    path.join(artifactRoot, 'installer-manifest.json'),
    JSON.stringify(manifest, null, 2) + '\n',
    'utf8',
  );

  process.stdout.write(
    'Windows Free Setup.exe built: ' + setupPath + '\n' +
    'Setup bytes: ' + setupStat.size + '\n' +
    'Setup SHA-256: ' + setupSha256 + '\n',
  );
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
