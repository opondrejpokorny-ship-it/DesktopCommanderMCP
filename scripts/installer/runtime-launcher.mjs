import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { claimRuntimeInstance } from './runtime-instance.mjs';

const runtimeRoot = path.dirname(fileURLToPath(import.meta.url));
const packageRoot = path.join(
  runtimeRoot,
  'app',
  'node_modules',
  '@wonderwhy-er',
  'desktop-commander-free-prototype',
);
const pidPath = path.join(runtimeRoot, 'runtime.pid');
const logDir = path.join(runtimeRoot, 'logs');
const logPath = path.join(logDir, 'runtime.log');
const foreground = process.argv.includes('--foreground') || process.argv.includes('--smoke');

await fsp.mkdir(logDir, { recursive: true });
const originalConsole = {
  log: console.log.bind(console),
  error: console.error.bind(console),
  warn: console.warn.bind(console),
  debug: console.debug.bind(console),
};
function renderPart(value) {
  if (typeof value === 'string') return value;
  try { return JSON.stringify(value); } catch { return String(value); }
}
function writeLog(level, values) {
  const line = new Date().toISOString() + ' [' + level + '] ' + values.map(renderPart).join(' ') + '\n';
  try { fs.appendFileSync(logPath, line, 'utf8'); } catch {}
  if (foreground) originalConsole[level === 'debug' ? 'log' : level](...values);
}
console.log = (...values) => writeLog('log', values);
console.error = (...values) => writeLog('error', values);
console.warn = (...values) => writeLog('warn', values);
console.debug = (...values) => writeLog('debug', values);

const instanceOwnership = await claimRuntimeInstance(pidPath);
process.on('exit', () => {
  try { instanceOwnership.releaseSync(); } catch {}
});

const controlCenterModule = pathToFileURL(
  path.join(runtimeRoot, 'control-center-server.mjs'),
).href;
const integrationModule = pathToFileURL(
  path.join(packageRoot, 'dist', 'remote-device', 'desktop-commander-integration.js'),
).href;
const remoteModule = pathToFileURL(
  path.join(packageRoot, 'dist', 'npm-scripts', 'remote.js'),
).href;

const { startControlCenter } = await import(controlCenterModule);
const controlCenter = await startControlCenter({
  host: '127.0.0.1',
  port: 17831,
  quiet: true,
});
console.log('Control Center listening at', controlCenter.url);

if (process.argv.includes('--smoke')) {
  const { DesktopCommanderIntegration } = await import(integrationModule);
  const integration = new DesktopCommanderIntegration();
  let toolCount = 0;
  try {
    const config = await integration.resolveMcpConfig();
    if (!config) throw new Error('Bundled local MCP configuration was not resolved');
    const expectedEntry = path.join(packageRoot, 'dist', 'index.js');
    if (path.resolve(config.command) !== path.resolve(process.execPath)) {
      throw new Error('Bundled local MCP must use the bundled Node executable');
    }
    if (config.args.length !== 1 || path.resolve(config.args[0]) !== path.resolve(expectedEntry)) {
      throw new Error('Bundled local MCP resolved an unexpected entrypoint');
    }
    await integration.initialize();
    const listed = await integration.listClientTools();
    toolCount = listed.tools?.length ?? 0;
    if (toolCount <= 0) throw new Error('Bundled local MCP returned no tools');
    const response = await fetch(controlCenter.url);
    if (!response.ok) throw new Error('Control Center smoke request failed: ' + response.status);
    const html = await response.text();
    if (!html.includes('Desktop Commander')) throw new Error('Control Center smoke response is not the expected UI');
    originalConsole.log(JSON.stringify({
      ok: true,
      node: process.version,
      mcpEntry: expectedEntry,
      toolCount,
      controlCenterUrl: controlCenter.url,
    }));
  } finally {
    await integration.shutdown().catch(() => undefined);
    await controlCenter.close().catch(() => undefined);
    await instanceOwnership.release().catch(() => undefined);
  }
  process.exit(0);
}

const { runRemote } = await import(remoteModule);
try {
  await runRemote();
} catch (error) {
  console.error('Remote runtime failed:', error);
  process.exitCode = 1;
} finally {
  await controlCenter.close().catch(() => undefined);
  await instanceOwnership.release().catch(() => undefined);
}
