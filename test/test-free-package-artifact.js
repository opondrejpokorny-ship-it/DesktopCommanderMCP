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
assert.ok(Array.isArray(manifest.files) && manifest.files.length > 0);

const normalizedFiles = manifest.files.map((entry) =>
  String(entry.path ?? entry).replaceAll('\\', '/').toLowerCase()
);
for (const forbidden of [
  'dist/policy/',
  'dist/prototype/',
  'dist/control-center/',
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
  execFileSync(
    process.platform === 'win32' ? 'npm.cmd' : 'npm',
    ['install', '--ignore-scripts', '--no-audit', '--no-fund', manifest.tarball],
    { cwd: consumerDir, stdio: 'inherit' },
  );

  const packageRoot = path.join(
    consumerDir,
    'node_modules',
    '@wonderwhy-er',
    'desktop-commander-free-prototype',
  );
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
