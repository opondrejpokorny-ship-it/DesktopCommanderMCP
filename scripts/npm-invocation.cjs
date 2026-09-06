const fs = require('node:fs');
const path = require('node:path');

const CMD_META = /([()\][%!^"`<>&|;, *?])/g;

function escapeCmdCommand(value) {
  return String(value).replace(CMD_META, '^$1');
}

function escapeCmdArgument(value) {
  let text = String(value);
  text = text.replace(/(\\*)"/g, '$1$1\\"');
  text = text.replace(/(\\*)$/, '$1$1');
  text = '"' + text + '"';
  return text.replace(CMD_META, '^$1');
}

function resolveNpmInvocation(args, options = {}) {
  const platform = options.platform ?? process.platform;
  if (platform !== 'win32') return { executable: 'npm', args: [...args] };

  const env = options.env ?? process.env;
  const existsSync = options.existsSync ?? fs.existsSync;
  const pathImpl = options.pathImpl ?? path.win32;
  const pathEntries = String(env.PATH ?? env.Path ?? '')
    .split(';')
    .filter(Boolean);

  for (const entry of pathEntries) {
    const npmExe = pathImpl.join(entry, 'npm.exe');
    if (existsSync(npmExe)) return { executable: npmExe, args: [...args] };

    const npmCmd = pathImpl.join(entry, 'npm.cmd');
    if (existsSync(npmCmd)) {
      const systemRoot = env.SystemRoot ?? env.SYSTEMROOT ?? 'C:\\Windows';
      const comSpec = env.ComSpec ?? env.COMSPEC ?? pathImpl.join(systemRoot, 'System32', 'cmd.exe');
      const shellCommand = [escapeCmdCommand(npmCmd), ...args.map(escapeCmdArgument)].join(' ');
      return {
        executable: comSpec,
        args: ['/d', '/s', '/c', '"' + shellCommand + '"'],
        options: { windowsVerbatimArguments: true },
      };
    }
  }

  throw new Error('npm executable was not found on Windows PATH');
}

module.exports = {
  escapeCmdArgument,
  resolveNpmInvocation,
};
