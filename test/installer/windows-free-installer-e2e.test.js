import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
if (process.platform !== 'win32' || process.arch !== 'x64') {
  console.log('SKIP Windows Free installer E2E: requires Windows x64');
  process.exit(0);
}

const artifactRoot = path.join(root, '.artifacts', 'windows-free-installer');
const runtimeRoot = path.join(root, '.artifacts', 'windows-free-runtime');
const setupPath = path.join(artifactRoot, 'DesktopCommanderFreeSetup.exe');
const powershell = path.join(process.env.WINDIR ?? 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');

function run(file, args, options = {}) {
  const result = spawnSync(file, args, {
    cwd: options.cwd ?? root,
    env: { ...process.env, ...(options.env ?? {}) },
    encoding: 'utf8',
    timeout: options.timeout ?? 180_000,
    windowsHide: true,
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error([
      `${path.basename(file)} failed with ${result.status}`,
      result.stdout,
      result.stderr,
    ].filter(Boolean).join('\n'));
  }
  return result;
}

async function sha256(filePath) {
  const hash = crypto.createHash('sha256');
  const handle = await fs.open(filePath, 'r');
  try {
    for await (const chunk of handle.createReadStream()) hash.update(chunk);
  } finally {
    await handle.close().catch(() => undefined);
  }
  return hash.digest('hex');
}

async function readJson(filePath) {
  return JSON.parse((await fs.readFile(filePath, 'utf8')).replace(/^\uFEFF/, ''));
}

if (process.env.DC_INSTALLER_REUSE_ARTIFACTS !== '1') {
  run(process.execPath, [path.join(root, 'scripts', 'installer', 'build-windows-free-installer.cjs')], {
    timeout: 900_000,
  });
}
const installerManifest = await readJson(path.join(artifactRoot, 'installer-manifest.json'));
const runtimeManifest = await readJson(path.join(runtimeRoot, 'runtime', 'runtime-manifest.json'));
assert.equal(installerManifest.kind, 'desktop-commander-windows-free-installer-v1');
assert.equal(installerManifest.signed, false);
assert.equal(installerManifest.setupSha256, await sha256(setupPath));
assert.equal(installerManifest.runtimeZipSha256, await sha256(path.join(runtimeRoot, 'runtime.zip')));
assert.equal(runtimeManifest.kind, 'desktop-commander-windows-free-runtime-v1');
assert.equal(runtimeManifest.signed, false);

const forbiddenBundleInputs = [
  '/src/policy/', '/src/prototype/', '/src/control-center/pro-extension.ts',
  '/src/control-center/team-extension.ts', '/src/control-center/demo-extension.ts',
  '/src/npm-scripts/access-control.ts',
];
for (const input of runtimeManifest.controlCenterBundleInputs) {
  const normalized = '/' + String(input).replaceAll('\\', '/').toLowerCase();
  assert.equal(
    forbiddenBundleInputs.some((marker) => normalized.includes(marker.toLowerCase())),
    false,
    `paid path leaked into public Control Center bundle: ${input}`,
  );
}

const caseRoot = path.join(os.tmpdir(), `desktop-commander-free-installer-e2e-${process.pid}`);
const installRoot = path.join(caseRoot, 'app');
const startupRoot = path.join(caseRoot, 'startup');
const profileRoot = path.join(caseRoot, 'profile');
await fs.rm(caseRoot, { recursive: true, force: true });
await fs.mkdir(startupRoot, { recursive: true });
const installerEnv = {
  DC_INSTALL_ROOT: installRoot,
  DC_STARTUP_DIR: startupRoot,
  DC_INSTALL_NO_LAUNCH: '1',
  DC_INSTALL_NO_STARTUP: '0',
  DC_INSTALL_QUIET: '1',
};

try {
  run(setupPath, [], { env: installerEnv, timeout: 180_000 });
  await fs.access(path.join(installRoot, 'node.exe'));
  await fs.access(path.join(installRoot, 'launcher.mjs'));
  await fs.access(path.join(startupRoot, 'DesktopCommanderFree.vbs'));

  const smokeEnv = {
    PATH: path.join(process.env.WINDIR ?? 'C:\\Windows', 'System32'),
    Path: path.join(process.env.WINDIR ?? 'C:\\Windows', 'System32'),
    USERPROFILE: profileRoot,
    HOME: profileRoot,
    DESKTOP_COMMANDER_WORKFLOW_STATE_DIR: path.join(profileRoot, 'workflow'),
    DESKTOP_COMMANDER_USAGE_FILE: path.join(profileRoot, 'usage.json'),
  };
  await fs.mkdir(profileRoot, { recursive: true });
  const smoke = run(path.join(installRoot, 'node.exe'), [path.join(installRoot, 'launcher.mjs'), '--smoke'], {
    env: smokeEnv,
    timeout: 120_000,
  });
  assert.match(smoke.stdout, /"ok":true/);
  assert.match(smoke.stdout, /"toolCount":29/);
  const installedManifest = await readJson(path.join(installRoot, 'runtime-manifest.json'));
  const launcherEntry = installedManifest.criticalFiles.find((entry) => entry.path === 'launcher.mjs');
  assert.ok(launcherEntry, 'launcher.mjs must be integrity-protected');
  await fs.writeFile(path.join(installRoot, 'launcher.mjs'), 'INTENTIONAL_REPAIR_CORRUPTION\n', 'ascii');
  assert.notEqual(await sha256(path.join(installRoot, 'launcher.mjs')), launcherEntry.sha256);

  run(setupPath, [], { env: installerEnv, timeout: 180_000 });
  assert.equal(await sha256(path.join(installRoot, 'launcher.mjs')), launcherEntry.sha256);
  await fs.access(path.join(startupRoot, 'DesktopCommanderFree.vbs'));

  const unrelatedStartup = path.join(startupRoot, 'unrelated.txt');
  await fs.writeFile(unrelatedStartup, 'KEEP\n', 'ascii');
  run(powershell, [
    '-NoLogo', '-NoProfile', '-ExecutionPolicy', 'Bypass',
    '-File', path.join(installRoot, 'uninstall.ps1'),
    '-InstallRoot', installRoot,
    '-StartupDir', startupRoot,
    '-Synchronous',
  ]);
  await assert.rejects(fs.access(installRoot));
  await assert.rejects(fs.access(path.join(startupRoot, 'DesktopCommanderFree.vbs')));
  await fs.access(unrelatedStartup);

  console.log('✅ Windows Free Setup install/repair/smoke/uninstall E2E passed');
} finally {
  await fs.rm(caseRoot, { recursive: true, force: true }).catch(() => undefined);
}
