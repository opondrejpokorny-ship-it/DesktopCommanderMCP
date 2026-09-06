const childProcess = require('node:child_process');
const path = require('node:path');

const root = path.resolve(__dirname, '..', '..');
const packageDir = path.join(root, '.artifacts', 'free', 'package');
const artifactRoot = path.join(root, '.artifacts', 'free');
const expectedArgs = ['pack', packageDir, '--json', '--pack-destination', artifactRoot];

function shouldStubNpmPack(executable, args) {
  const base = path.basename(String(executable)).toLowerCase();
  if (base !== 'npm' && base !== 'npm.cmd') return false;
  if (!Array.isArray(args) || args.length !== expectedArgs.length) return false;
  return args.every((arg, index) => arg === expectedArgs[index]);
}

const originalExecFileSync = childProcess.execFileSync;
childProcess.execFileSync = function patchedExecFileSync(executable, args, options) {
  if (shouldStubNpmPack(executable, args)) {
    return JSON.stringify([{ filename: 'r3-pack-stub.tgz', files: [] }]);
  }
  return originalExecFileSync.call(this, executable, args, options);
};

module.exports = { shouldStubNpmPack };
