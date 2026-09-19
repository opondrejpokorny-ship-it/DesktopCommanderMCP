import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
if (process.platform !== 'win32' || process.arch !== 'x64') {
  console.log('SKIP Windows Free runtime native deps: requires Windows x64');
  process.exit(0);
}

const runtime = path.join(root, '.artifacts', 'windows-free-runtime', 'runtime');
const bundledNode = path.join(runtime, 'node.exe');
const packageRoot = path.join(
  runtime, 'app', 'node_modules', '@wonderwhy-er', 'desktop-commander-free-prototype',
);
await fs.access(bundledNode);

const cleanPath = path.join(process.env.WINDIR ?? 'C:\\Windows', 'System32');
const env = { ...process.env, PATH: cleanPath, Path: cleanPath };
const ripgrepModule = path.join(packageRoot, 'dist', 'utils', 'ripgrep-resolver.js');
const ripgrepProbe = [
  "import {pathToFileURL} from 'node:url'",
  "import {spawnSync} from 'node:child_process'",
  "const m=await import(pathToFileURL(process.argv[1]).href)",
  "const p=await m.getRipgrepPath()",
  "const r=spawnSync(p,['--version'],{encoding:'utf8'})",
  "console.log(JSON.stringify({path:p,status:r.status,version:(r.stdout||'').split(/\\r?\\n/)[0]}))",
  "if(r.status!==0) process.exit(1)",
].join(';');
const ripgrep = spawnSync(bundledNode, ['--input-type=module', '-e', ripgrepProbe, ripgrepModule], {
  env, encoding: 'utf8', windowsHide: true,
});
assert.equal(ripgrep.status, 0, ripgrep.stderr || ripgrep.stdout);
const ripgrepResult = JSON.parse(ripgrep.stdout.trim());
assert.match(ripgrepResult.path, /@vscode[\\/]ripgrep[\\/]bin[\\/]rg\.exe$/i);
assert.equal(ripgrepResult.status, 0);
assert.match(ripgrepResult.version, /^ripgrep /);

const sharpRoot = path.join(runtime, 'app', 'node_modules', 'sharp');
const sharpProbe = [
  "const sharp=require(process.argv[1])",
  "if(!sharp.versions || !sharp.versions.sharp) process.exit(2)",
  "console.log(JSON.stringify({sharp:sharp.versions.sharp,vips:sharp.versions.vips}))",
].join(';');
const sharp = spawnSync(bundledNode, ['-e', sharpProbe, sharpRoot], {
  env, encoding: 'utf8', windowsHide: true,
});
assert.equal(sharp.status, 0, sharp.stderr || sharp.stdout);
const sharpResult = JSON.parse(sharp.stdout.trim());
assert.equal(sharpResult.sharp, '0.34.5');
assert.ok(sharpResult.vips);

console.log('✅ Windows Free runtime native dependency smoke passed');
