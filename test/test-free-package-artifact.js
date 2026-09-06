import assert from 'node:assert';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const __filename = fileURLToPath(import.meta.url);
const root = path.resolve(path.dirname(__filename), '..');
const buildScript = path.join(root, 'scripts/build-free-package.cjs');

function resolveNpmInvocation(args) {
  if (process.platform !== 'win32') return { executable: 'npm', args };
  const npmCli = path.join(
    path.dirname(process.execPath), 'node_modules', 'npm', 'bin', 'npm-cli.js',
  );
  return { executable: process.execPath, args: [npmCli, ...args] };
}

assert.ok(
  await fs.stat(buildScript).then(() => true, () => false),
  'A real Free package build script must exist',
);

execFileSync(process.execPath, [buildScript], {
  cwd: root,
  stdio: 'inherit',
});

const manifestPath = path.join(root, '.artifacts/free/package-manifest.json');
const manifest = JSON.parse(await fs.readFile(manifestPath, 'utf8'));
assert.ok(manifest.tarball, 'Free package manifest must point to a tarball');
const tarballPath = path.resolve(path.dirname(manifestPath), manifest.tarball);
assert.ok(Array.isArray(manifest.files) && manifest.files.length > 0);

const normalizedFiles = manifest.files.map((entry) =>
  String(entry.path ?? entry).replaceAll('\\', '/').toLowerCase()
);
for (const required of [
  'dist/commercial-contract.js',
  'dist/commercial-contract.d.ts',
  'dist/control-center-contract.js',
  'dist/control-center-contract.d.ts',
  'dist/control-center/contract.js',
  'dist/control-center/contract.d.ts',
  'dist/control-center/host.js',
  'dist/control-center/host.d.ts',
]) {
  assert.ok(normalizedFiles.includes(required), 'Free artifact must ship public Control Center path: ' + required);
}
for (const forbidden of [
  'dist/policy/',
  'dist/prototype/',
  'dist/control-center/pro-extension.js',
  'dist/control-center/team-extension.js',
  'dist/control-center/demo-extension.js',
  'dist/control-center/server.js',
  'dist/npm-scripts/access-control.js',
]) {
  assert.ok(
    normalizedFiles.every((file) => !file.includes(forbidden)),
    'Free artifact must not ship commercial path: ' + forbidden,
  );
}

const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'dc-free-package-consumer-'));
const consumerDir = path.join(tempDir, 'consumer');
const homeDir = path.join(tempDir, 'home');
await fs.mkdir(consumerDir, { recursive: true });
await fs.mkdir(homeDir, { recursive: true });
await fs.writeFile(
  path.join(consumerDir, 'package.json'),
  JSON.stringify({ name: 'dc-free-consumer', private: true, version: '1.0.0' }),
);

try {
  const npmInstall = resolveNpmInvocation([
    'install', '--ignore-scripts', '--no-audit', '--no-fund', tarballPath,
  ]);
  execFileSync(npmInstall.executable, npmInstall.args, {
    cwd: consumerDir,
    stdio: 'inherit',
  });

  const packageRoot = path.join(
    consumerDir,
    'node_modules',
    '@wonderwhy-er',
    'desktop-commander-free-prototype',
  );
  const installedPackage = JSON.parse(await fs.readFile(path.join(packageRoot, 'package.json'), 'utf8'));
  assert.deepStrictEqual(installedPackage.exports['./commercial-contract'], {
    types: './dist/commercial-contract.d.ts',
    import: './dist/commercial-contract.js',
  });
  assert.deepStrictEqual(installedPackage.exports['./control-center-contract'], {
    types: './dist/control-center-contract.d.ts',
    import: './dist/control-center-contract.js',
  });
  const commercialContractSmoke = path.join(consumerDir, 'commercial-contract-smoke.mjs');
  await fs.writeFile(commercialContractSmoke, `
import { COMMERCIAL_CONTRACT_VERSION, CapabilityRegistry, configureRuntimeServices } from '@wonderwhy-er/desktop-commander-free-prototype/commercial-contract';
if (COMMERCIAL_CONTRACT_VERSION !== 1) throw new Error('Commercial contract version mismatch');
if (typeof CapabilityRegistry !== 'function' || typeof configureRuntimeServices !== 'function') throw new Error('Commercial contract runtime exports missing');
console.log('FREE_COMMERCIAL_CONTRACT_OK');
`, 'utf8');
  execFileSync(process.execPath, [commercialContractSmoke], { cwd: consumerDir, stdio: 'inherit' });
  const controlCenterSmoke = path.join(consumerDir, 'control-center-smoke.mjs');
  await fs.writeFile(controlCenterSmoke, `
import { startControlCenterHost } from '@wonderwhy-er/desktop-commander-free-prototype/control-center-contract';
const running = await startControlCenterHost({ host: '127.0.0.1', port: 0, token: 'free-control-token', quiet: true });
try {
  const home = await fetch(running.url);
  if (home.status !== 200) throw new Error('Free Control Center home failed');
  const response = await fetch(new URL('/api/state', running.url), { headers: { 'X-DC-Control-Token': running.token } });
  const state = await response.json();
  if (response.status !== 200 || state.entitlement?.tier !== 'free' || state.activeExtensions?.length !== 0) {
    throw new Error('Free Control Center state mismatch: ' + JSON.stringify(state));
  }
  for (const subpath of ['control-center/pro-extension', 'control-center/team-extension', 'control-center/demo-extension', 'control-center/server']) {
    try {
      await import('@wonderwhy-er/desktop-commander-free-prototype/' + subpath);
      throw new Error('Commercial subpath unexpectedly imported: ' + subpath);
    } catch (error) {
      if (!['ERR_PACKAGE_PATH_NOT_EXPORTED', 'ERR_MODULE_NOT_FOUND'].includes(error?.code)) throw error;
    }
  }
  console.log('FREE_CONTROL_CENTER_HOST_OK');
} finally {
  await running.close();
}
`, 'utf8');
  execFileSync(process.execPath, [controlCenterSmoke], { cwd: consumerDir, stdio: 'inherit' });

  const entry = path.join(packageRoot, 'dist/index.js');
  assert.ok(await fs.stat(entry).then(() => true, () => false));
  assert.ok(
    !await fs.stat(path.join(packageRoot, 'dist/policy')).then(() => true, () => false),
    'Installed Free package must not contain dist/policy',
  );
  assert.ok(
    !await fs.stat(path.join(packageRoot, 'dist/prototype')).then(() => true, () => false),
    'Installed Free package must not contain dist/prototype',
  );

  await assert.rejects(
    import(pathToFileURL(path.join(packageRoot, 'dist/policy/approval-store.js')).href),
    /cannot find module|err_module_not_found/i,
  );

  const testFile = path.join(homeDir, 'free-smoke.txt');
  await fs.writeFile(testFile, 'FREE_PACKAGE_CORE_OK');

  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [entry, '--no-onboarding'],
    cwd: consumerDir,
    stderr: 'pipe',
    env: {
      ...process.env,
      HOME: homeDir,
      USERPROFILE: homeDir,
      DESKTOP_COMMANDER_DISABLE_TELEMETRY: 'true',
    },
  });
  const client = new Client(
    { name: 'free-package-smoke', version: '1.0.0' },
    { capabilities: {} },
  );

  try {
    await client.connect(transport, { timeout: 30000 });
    const tools = await client.listTools();
    for (const tool of ['read_file', 'write_file', 'report_task_progress']) {
      assert.ok(tools.tools.some((item) => item.name === tool), tool + ' must exist');
    }

    const read = await client.callTool({
      name: 'read_file',
      arguments: { path: testFile },
    });
    assert.ok(!read.isError, JSON.stringify(read));
    assert.match(
      read.content?.find?.((item) => item.type === 'text')?.text ?? '',
      /FREE_PACKAGE_CORE_OK/,
    );

    const writeTarget = path.join(homeDir, 'free-write-smoke.txt');
    const write = await client.callTool({
      name: 'write_file',
      arguments: {
        path: writeTarget,
        content: 'FREE_PACKAGE_WRITE_OK',
        mode: 'rewrite',
      },
    });
    assert.ok(!write.isError, JSON.stringify(write));
    assert.strictEqual(
      await fs.readFile(writeTarget, 'utf8'),
      'FREE_PACKAGE_WRITE_OK',
      'Installed Free package should retain upstream write access without commercial approval code',
    );

    const progress = await client.callTool({
      name: 'report_task_progress',
      arguments: {
        percentRemaining: 25,
        currentPhase: 'free package smoke',
        estimatedRemainingMinutes: 10,
      },
    });
    assert.ok(!progress.isError);
    const parsed = JSON.parse(
      progress.content?.find?.((item) => item.type === 'text')?.text ?? '{}',
    );
    assert.strictEqual(parsed.tier, 'free');
    assert.ok(!('estimatedRemainingMinutes' in parsed));
    assert.ok(!('estimatedRemainingText' in parsed));
  } finally {
    await client.close().catch(() => undefined);
  }

  console.log('✅ Installable Free package artifact tests passed');
} finally {
  await fs.rm(tempDir, { recursive: true, force: true });
}
