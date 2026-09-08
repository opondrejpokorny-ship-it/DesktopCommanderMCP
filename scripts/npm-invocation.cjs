const fs = require('node:fs');
const path = require('node:path');

function cleanPathEntry(value) {
  const trimmed = String(value).trim();
  if (trimmed.length >= 2 && trimmed.startsWith('"') && trimmed.endsWith('"')) {
    return trimmed.slice(1, -1);
  }
  return trimmed;
}

function resolveNpmInvocation(args, options = {}) {
  const platform = options.platform ?? process.platform;
  if (platform !== 'win32') return { executable: 'npm', args: [...args] };

  const env = options.env ?? process.env;
  const existsSync = options.existsSync ?? fs.existsSync;
  const pathImpl = options.pathImpl ?? path.win32;
  const processExecPath = options.processExecPath ?? process.execPath;
  const entries = String(env.PATH ?? env.Path ?? '')
    .split(';')
    .map(cleanPathEntry)
    .filter(Boolean);

  for (const entry of entries) {
    const npmExe = pathImpl.join(entry, 'npm.exe');
    if (existsSync(npmExe)) return { executable: npmExe, args: [...args] };

    const npmCmd = pathImpl.join(entry, 'npm.cmd');
    if (!existsSync(npmCmd)) continue;

    const npmCli = pathImpl.join(entry, 'node_modules', 'npm', 'bin', 'npm-cli.js');
    if (existsSync(npmCli)) {
      return { executable: processExecPath, args: [npmCli, ...args] };
    }
    throw new Error(
      'npm.cmd is first on Windows PATH but its adjacent npm-cli.js was not found; refusing unsafe fallback',
    );
  }

  throw new Error(
    'A safe npm launcher was not found on Windows PATH (expected npm.exe or npm.cmd with adjacent npm-cli.js)',
  );
}

module.exports = { resolveNpmInvocation };
