import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const modulePath = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
  'scripts',
  'installer',
  'runtime-instance.mjs',
);
const { claimRuntimeInstance } = await import(pathToFileURL(modulePath).href);
const root = await fs.mkdtemp(path.join(os.tmpdir(), 'dc-runtime-instance-'));
const pidPath = path.join(root, 'runtime.pid');

try {
  const first = await claimRuntimeInstance(pidPath, {
    pid: 111,
    isPidAlive: async (pid) => pid === 111,
  });
  assert.equal((await fs.readFile(pidPath, 'utf8')).trim(), '111');

  await assert.rejects(
    claimRuntimeInstance(pidPath, {
      pid: 222,
      isPidAlive: async (pid) => pid === 111,
    }),
    /already running|owned/i,
  );
  assert.equal((await fs.readFile(pidPath, 'utf8')).trim(), '111');

  await first.release();
  await assert.rejects(fs.access(pidPath));

  await fs.writeFile(pidPath, '333\n', 'utf8');
  await assert.rejects(
    claimRuntimeInstance(pidPath, {
      pid: 444,
      isPidAlive: async () => false,
    }),
    /ownership exists|stale/i,
  );
  assert.equal((await fs.readFile(pidPath, 'utf8')).trim(), '333');

  await fs.rm(pidPath, { force: true });
  const owned = await claimRuntimeInstance(pidPath, { pid: 444 });
  await fs.writeFile(pidPath, '555\n', 'utf8');
  await owned.release();
  assert.equal((await fs.readFile(pidPath, 'utf8')).trim(), '555');

  console.log('✅ Windows Free runtime instance ownership is atomic');
} finally {
  await fs.rm(root, { recursive: true, force: true }).catch(() => undefined);
}
