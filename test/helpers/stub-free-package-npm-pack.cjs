const childProcess = require('node:child_process');
const path = require('node:path');

const root = path.resolve(__dirname, '..', '..');
const packageDir = path.join(root, '.artifacts', 'free', 'package');
const artifactRoot = path.join(root, '.artifacts', 'free');
const expectedArgs = ['pack', packageDir, '--json', '--pack-destination', artifactRoot];

function hasExpectedPackArgs(args, offset = 0) {
  if (!Array.isArray(args) || args.length !== expectedArgs.length + offset) return false;
  return expectedArgs.every((arg, index) => args[index + offset] === arg);
}

function shouldStubNpmPack(executable, args) {
  const base = path.basename(String(executable)).toLowerCase();
  if (['npm', 'npm.cmd', 'npm.exe'].includes(base)) {
    return hasExpectedPackArgs(args);
  }
  if (!hasExpectedPackArgs(args, 1)) return false;
  const npmCli = String(args[0]).replaceAll('\\', '/').toLowerCase();
  return npmCli.endsWith('/node_modules/npm/bin/npm-cli.js');
}

const originalExecFileSync = childProcess.execFileSync;
childProcess.execFileSync = function patchedExecFileSync(executable, args, options) {
  if (shouldStubNpmPack(executable, args)) {
    return JSON.stringify([{ filename: 'r3-pack-stub.tgz', files: [] }]);
  }
  return originalExecFileSync.call(this, executable, args, options);
};

module.exports = { shouldStubNpmPack };
