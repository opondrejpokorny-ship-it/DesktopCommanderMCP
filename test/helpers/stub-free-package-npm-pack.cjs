const childProcess = require('node:child_process');
const path = require('node:path');
const originalExecFileSync = childProcess.execFileSync;
childProcess.execFileSync = function patchedExecFileSync(executable, args, options) {
  const base = path.basename(String(executable)).toLowerCase();
  if ((base === 'npm' || base === 'npm.cmd') && Array.isArray(args) && args[0] === 'pack') {
    return JSON.stringify([{ filename: 'r3-pack-stub.tgz', files: [] }]);
  }
  return originalExecFileSync.call(this, executable, args, options);
};
