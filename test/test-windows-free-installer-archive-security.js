import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

if (process.platform !== 'win32' || process.arch !== 'x64') {
  console.log('SKIP Windows Free installer archive security: requires Windows x64');
  process.exit(0);
}

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const powershell = path.join(
  process.env.WINDIR ?? 'C:\\Windows',
  'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe',
);
const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'dc-installer-archive-'));
const payloadRoot = path.join(tempRoot, 'payload');
const runtimeZip = path.join(payloadRoot, 'runtime.zip');
const installRoot = path.join(tempRoot, 'install-target');
const startupRoot = path.join(tempRoot, 'startup');
const escapePath = path.join(tempRoot, 'escape.txt');

async function sha256(filePath) {
  const hash = crypto.createHash('sha256');
  const bytes = await fs.readFile(filePath);
  return hash.update(bytes).digest('hex');
}

try {
  await fs.mkdir(payloadRoot, { recursive: true });
  await fs.mkdir(startupRoot, { recursive: true });
  await fs.copyFile(
    path.join(root, 'scripts', 'installer', 'install-windows-free.ps1'),
    path.join(payloadRoot, 'install.ps1'),
  );

  const createZip = [
    'Add-Type -AssemblyName System.IO.Compression',
    'Add-Type -AssemblyName System.IO.Compression.FileSystem',
    '$stream=[IO.File]::Open($env:DC_TEST_ZIP,[IO.FileMode]::Create)',
    '$archive=New-Object IO.Compression.ZipArchive($stream,[IO.Compression.ZipArchiveMode]::Create,$false)',
    '$entry=$archive.CreateEntry("../escape.txt")',
    '$writer=New-Object IO.StreamWriter($entry.Open())',
    '$writer.Write("MUST_NOT_ESCAPE")',
    '$writer.Dispose(); $archive.Dispose(); $stream.Dispose()',
  ].join('; ');

  const zipResult = spawnSync(powershell, ['-NoLogo', '-NoProfile', '-Command', createZip], {
    env: { ...process.env, DC_TEST_ZIP: runtimeZip },
    encoding: 'utf8',
    windowsHide: true,
  });
  assert.equal(zipResult.status, 0, zipResult.stderr || zipResult.stdout);

  await fs.writeFile(
    path.join(payloadRoot, 'payload-manifest.json'),
    JSON.stringify({
      kind: 'desktop-commander-windows-free-installer-payload-v1',
      runtimeZipSha256: await sha256(runtimeZip),
    }, null, 2) + '\n',
  );

  const installResult = spawnSync(powershell, [
    '-NoLogo', '-NoProfile', '-ExecutionPolicy', 'Bypass',
    '-File', path.join(payloadRoot, 'install.ps1'),
    '-InstallRoot', installRoot,
    '-StartupDir', startupRoot,
    '-NoLaunch', '-NoStartup', '-Quiet',
  ], { encoding: 'utf8', windowsHide: true, timeout: 30_000 });

  assert.notEqual(installResult.status, 0, 'traversal archive must fail closed');
  assert.match(installResult.stderr + installResult.stdout, /traversal path/i);

  await assert.rejects(fs.access(escapePath));
  await assert.rejects(fs.access(installRoot));
  console.log('✅ Windows Free installer rejects traversal archives before extraction');
} finally {
  await fs.rm(tempRoot, { recursive: true, force: true }).catch(() => undefined);
}
