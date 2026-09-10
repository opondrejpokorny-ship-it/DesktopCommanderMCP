import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const home = mkdtempSync(path.join(os.tmpdir(), 'dc-config-atomic-'));
const configDir = path.join(home, '.claude-server-commander');
const configPath = path.join(configDir, 'config.json');
const seed = { telemetryEnabled: false, welcomeOnboardingEligible: true, pendingWelcomeOnboarding: false };
mkdirSync(configDir, { recursive: true });
writeFileSync(configPath, JSON.stringify(seed, null, 2));
process.env.HOME = home;
process.env.USERPROFILE = home;

const { configManager } = await import('../dist/config-manager.js');
const originalWriteFile = fs.writeFile;
const failureMessage = 'simulated interrupted config write';

async function blockFirstPersistence(startOperation, whileBlocked = async () => {}, reject = false) {
  let intercepted = false;
  let interceptedTarget = null;
  let startedResolve;
  let releaseResolve;
  const started = new Promise((resolve) => { startedResolve = resolve; });
  const release = new Promise((resolve) => { releaseResolve = resolve; });

  fs.writeFile = async (target, ...args) => {
    if (!intercepted) {
      intercepted = true;
      interceptedTarget = String(target);
      startedResolve();
      await release;
      if (reject) {
        writeFileSync(interceptedTarget, '');
        throw new Error(failureMessage);
      }
    }
    return originalWriteFile(target, ...args);
  };

  try {
    const operation = startOperation();
    await started;
    await whileBlocked();
    releaseResolve();
    if (reject) {
      await assert.rejects(operation, new RegExp(failureMessage));
    } else {
      await operation;
    }
    return interceptedTarget;
  } finally {
    releaseResolve();
    fs.writeFile = originalWriteFile;
  }
}

function readDiskConfig() {
  return JSON.parse(readFileSync(configPath, 'utf8'));
}

try {
  const interruptedTarget = await blockFirstPersistence(
    () => configManager.setValue('atomicProbe', 'new-value'),
    undefined,
    true,
  );
  const preserved = readDiskConfig();
  assert.equal(preserved.atomicProbe, undefined, 'failed persistence must keep last committed config');
  assert.equal(preserved.telemetryEnabled, false);
  assert.ok(interruptedTarget, 'test must intercept a persistence write');
  assert.notEqual(interruptedTarget, configPath,
    'crash-safe persistence must write a sibling temporary file before replacing config.json');
  assert.equal(await configManager.getValue('atomicProbe'), undefined,
    'a rejected awaited save must not remain in memory');

  await configManager.setValue('laterProbe', 'committed');
  let afterLaterSave = readDiskConfig();
  assert.equal(afterLaterSave.atomicProbe, undefined,
    'a later unrelated save must not persist a previously rejected mutation');
  assert.equal(afterLaterSave.laterProbe, 'committed');

  await blockFirstPersistence(
    () => configManager.updateConfig({ updateRejected: 'bad', telemetryEnabled: true }),
    undefined,
    true,
  );
  assert.equal(await configManager.getValue('updateRejected'), undefined,
    'failed updateConfig must not remain in memory');
  assert.equal(await configManager.getValue('telemetryEnabled'), false,
    'failed updateConfig must preserve the prior in-memory values');

  await blockFirstPersistence(
    () => configManager.resetConfig(),
    undefined,
    true,
  );
  assert.equal(await configManager.getValue('laterProbe'), 'committed',
    'failed resetConfig must preserve the prior in-memory config');
  assert.equal(await configManager.getValue('telemetryEnabled'), false,
    'failed resetConfig must preserve the prior telemetry value');

  await configManager.setValue('sharedProbe', 'base');
  await blockFirstPersistence(
    () => configManager.setValue('sharedProbe', 'rejected'),
    async () => {
      await configManager.setValueNonBlocking('sharedProbe', 'newer');
      await configManager.setValueNonBlocking('concurrentProbe', 'kept');
    },
    true,
  );

  assert.equal(await configManager.getValue('sharedProbe'), 'newer',
    'failed awaited mutation must not overwrite a newer same-key non-blocking mutation');
  assert.equal(await configManager.getValue('concurrentProbe'), 'kept',
    'failed awaited mutation must not roll back unrelated newer mutations');

  await configManager.setValue('flushAfterRejectedConcurrent', 'committed');
  let afterRejectedConcurrent = readDiskConfig();
  assert.equal(afterRejectedConcurrent.sharedProbe, 'newer');
  assert.equal(afterRejectedConcurrent.concurrentProbe, 'kept');
  assert.equal(afterRejectedConcurrent.atomicProbe, undefined,
    'rejected awaited mutations must remain absent after later persistence');

  let queuedAwaited;
  await blockFirstPersistence(
    () => configManager.setValue('queueBlocker', 'held'),
    async () => {
      queuedAwaited = configManager.setValue('queuedRace', 'older-awaited');
      await Promise.resolve();
      await configManager.setValueNonBlocking('queuedRace', 'newer-nonblocking');
    },
    false,
  );
  await queuedAwaited;
  await configManager.setValue('flushQueuedRace', 'committed');
  assert.equal(await configManager.getValue('queuedRace'), 'newer-nonblocking',
    'an older awaited mutation already queued must not clobber a later non-blocking update');
  assert.equal(readDiskConfig().queuedRace, 'newer-nonblocking',
    'disk must preserve the later non-blocking value after the older awaited mutation completes');

  await configManager.setValue('sharedProbe', 'before-success-race');
  await blockFirstPersistence(
    () => configManager.setValue('sharedProbe', 'awaited-value'),
    async () => {
      await configManager.setValueNonBlocking('sharedProbe', 'newer-after-await-start');
    },
    false,
  );
  await configManager.setValue('flushAfterSuccessfulConcurrent', 'committed');
  assert.equal(await configManager.getValue('sharedProbe'), 'newer-after-await-start',
    'a successful awaited save must not clobber a later same-key non-blocking mutation');
  const afterSuccessfulConcurrent = readDiskConfig();
  assert.equal(afterSuccessfulConcurrent.sharedProbe, 'newer-after-await-start');

  await Promise.all([
    configManager.setValue('awaitedConcurrentA', 'A'),
    configManager.setValue('awaitedConcurrentB', 'B'),
  ]);
  await configManager.setValue('finalFlushProbe', 'committed');
  const finalConfig = readDiskConfig();
  assert.equal(finalConfig.awaitedConcurrentA, 'A', 'concurrent awaited saves must retain A');
  assert.equal(finalConfig.awaitedConcurrentB, 'B', 'concurrent awaited saves must retain B');
  assert.equal(finalConfig.finalFlushProbe, 'committed');

  console.log('✅ Config persistence is atomic and concurrency-safe across awaited mutations');
} finally {
  fs.writeFile = originalWriteFile;
  rmSync(home, { recursive: true, force: true });
}
