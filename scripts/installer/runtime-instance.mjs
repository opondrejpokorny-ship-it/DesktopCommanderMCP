import fs from 'node:fs';
import fsp from 'node:fs/promises';

function defaultIsPidAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if (error?.code === 'ESRCH') return false;
    if (error?.code === 'EPERM') return true;
    throw error;
  }
}

async function readOwner(pidPath) {
  try {
    return (await fsp.readFile(pidPath, 'utf8')).trim();
  } catch (error) {
    if (error?.code === 'ENOENT') return null;
    throw error;
  }
}

export async function claimRuntimeInstance(
  pidPath,
  { pid = process.pid, isPidAlive = defaultIsPidAlive } = {},
) {
  const owner = String(pid);
  try {
    await fsp.writeFile(pidPath, owner + '\n', { encoding: 'utf8', flag: 'wx' });
  } catch (error) {
    if (error?.code !== 'EEXIST') throw error;
    const existing = await readOwner(pidPath);
    const existingPid = Number(existing);
    const live = Number.isInteger(existingPid) && existingPid > 0
      ? await isPidAlive(existingPid)
      : null;
    if (live === true) {
      throw new Error(`Desktop Commander Free is already running (PID ${existingPid})`);
    }
    throw new Error(
      'Desktop Commander Free runtime ownership exists but is stale or invalid; ' +
      'run Repair before starting another instance',
    );
  }

  async function release() {
    const current = await readOwner(pidPath);
    if (current === owner) await fsp.rm(pidPath, { force: true });
  }

  function releaseSync() {
    try {
      const current = fs.readFileSync(pidPath, 'utf8').trim();
      if (current === owner) fs.rmSync(pidPath, { force: true });
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error;
    }
  }

  return { pid, release, releaseSync };
}
