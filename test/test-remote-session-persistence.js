import assert from 'node:assert';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { MCPDevice } from '../dist/remote-device/device.js';

process.env.DESKTOP_COMMANDER_DISABLE_TELEMETRY = '1';

async function createHarness(persistSession = true) {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'dc-session-persist-'));
  const configPath = path.join(tempDir, 'device.json');
  const device = new MCPDevice({ persistSession });
  device.configPath = configPath;
  device.deviceId = 'synthetic-device';
  let authListener = null;
  let currentSession = null;
  let refreshSessionResult = null;
  let resolveRefreshCall;
  let refreshCalled = Promise.resolve();
  let refreshRelease = null;

  const remote = device.remoteChannel;
  remote.client = {
    realtime: { setAuth() {} },
    auth: {
      async setSession(session) {
        currentSession = { ...session };
        return { error: null };
      },
      async getUser() {
        return { data: { user: { id: 'synthetic-user', email: 'test@example.invalid' } }, error: null };
      },
      async getSession() {
        return { data: { session: currentSession }, error: null };
      },
      async refreshSession() {
        resolveRefreshCall?.();
        if (refreshRelease) await refreshRelease.promise;
        if (refreshSessionResult) currentSession = { ...refreshSessionResult };
        return { data: { session: currentSession }, error: null };
      },
      onAuthStateChange(listener) {
        authListener = listener;
        return { data: { subscription: { unsubscribe() {} } } };
      },
    },
  };

  return {
    tempDir,
    configPath,
    device,
    remote,
    setCurrentSession(session) { currentSession = session; },
    setRefreshSessionResult(session) {
      refreshSessionResult = session;
      refreshCalled = new Promise((resolve) => { resolveRefreshCall = resolve; });
    },
    holdRefreshSession() {
      let release;
      const promise = new Promise((resolve) => { release = resolve; });
      refreshRelease = { promise, release };
    },
    releaseRefreshSession() {
      refreshRelease?.release();
      refreshRelease = null;
    },
    emit(event, session) { authListener?.(event, session); },
    async waitForRefreshCall() { await refreshCalled; },
    async waitForPersistence() { await device.sessionPersistChain; },
    async cleanup() { await fs.rm(tempDir, { recursive: true, force: true }); },
  };
}

async function seedOldSession(harness) {
  await harness.remote.setSession({
    access_token: 'SYNTHETIC_ACCESS_OLD',
    refresh_token: 'SYNTHETIC_REFRESH_OLD',
  });
  await harness.device.savePersistedConfig();
}async function testRotatedSessionPersists() {
  const harness = await createHarness(true);
  try {
    await seedOldSession(harness);
    const rotated = {
      access_token: 'SYNTHETIC_ACCESS_ROTATED',
      refresh_token: 'SYNTHETIC_REFRESH_ROTATED',
    };
    harness.setCurrentSession(rotated);
    harness.emit('TOKEN_REFRESHED', rotated);
    await harness.waitForPersistence();

    const persisted = JSON.parse(await fs.readFile(harness.configPath, 'utf8'));
    assert.strictEqual(persisted.session?.refresh_token, 'SYNTHETIC_REFRESH_ROTATED');
    assert.strictEqual(persisted.session?.access_token, 'SYNTHETIC_ACCESS_ROTATED');
  } finally {
    await harness.cleanup();
  }
  console.log('✅ rotated remote session persisted to device.json');
}

async function testNoPersistModeStaysSessionless() {
  const harness = await createHarness(false);
  try {
    await seedOldSession(harness);
    const rotated = {
      access_token: 'SYNTHETIC_ACCESS_ROTATED',
      refresh_token: 'SYNTHETIC_REFRESH_ROTATED',
    };    harness.setCurrentSession(rotated);
    harness.emit('TOKEN_REFRESHED', rotated);
    await harness.waitForPersistence();

    const persisted = JSON.parse(await fs.readFile(harness.configPath, 'utf8'));
    assert.strictEqual(persisted.session, null, '--no-persist-session must not write rotated credentials');
  } finally {
    await harness.cleanup();
  }
  console.log('✅ no-persist mode does not persist rotated credentials');
}

async function testRapidRotationsKeepNewestSession() {
  const harness = await createHarness(true);
  try {
    await seedOldSession(harness);
    const first = { access_token: 'SYNTHETIC_ACCESS_1', refresh_token: 'SYNTHETIC_REFRESH_1' };
    const second = { access_token: 'SYNTHETIC_ACCESS_2', refresh_token: 'SYNTHETIC_REFRESH_2' };

    harness.setCurrentSession(first);
    harness.emit('TOKEN_REFRESHED', first);
    harness.setCurrentSession(second);
    harness.emit('TOKEN_REFRESHED', second);
    await harness.waitForPersistence();

    const persisted = JSON.parse(await fs.readFile(harness.configPath, 'utf8'));
    assert.strictEqual(persisted.session?.refresh_token, 'SYNTHETIC_REFRESH_2');
    assert.strictEqual(persisted.session?.access_token, 'SYNTHETIC_ACCESS_2');
  } finally {
    await harness.cleanup();  }
  console.log('✅ rapid token rotations persist the newest session');
}

async function testSignedOutRecoveryPersistsRenewedSession() {
  const harness = await createHarness(true);
  try {
    await seedOldSession(harness);
    const renewed = {
      access_token: 'SYNTHETIC_ACCESS_RECOVERED',
      refresh_token: 'SYNTHETIC_REFRESH_RECOVERED',
    };
    harness.setRefreshSessionResult(renewed);
    harness.emit('SIGNED_OUT', null);
    await harness.waitForRefreshCall();
    await new Promise((resolve) => setImmediate(resolve));
    await harness.waitForPersistence();

    const persisted = JSON.parse(await fs.readFile(harness.configPath, 'utf8'));
    assert.strictEqual(
      persisted.session?.refresh_token,
      renewed.refresh_token,
      'SIGNED_OUT recovery must persist the refresh token returned by forced refresh',
    );
    assert.strictEqual(persisted.session?.access_token, renewed.access_token);
  } finally {
    await harness.cleanup();
  }
  console.log('✅ SIGNED_OUT recovery persists the renewed remote session');
}

async function testNoPersistSignedOutRecoveryStaysSessionless() {
  const harness = await createHarness(false);
  try {
    await seedOldSession(harness);
    const renewed = {
      access_token: 'SYNTHETIC_ACCESS_RECOVERED',
      refresh_token: 'SYNTHETIC_REFRESH_RECOVERED',
    };
    harness.setRefreshSessionResult(renewed);
    harness.emit('SIGNED_OUT', null);
    await harness.waitForRefreshCall();
    await new Promise((resolve) => setImmediate(resolve));
    await harness.waitForPersistence();

    const persisted = JSON.parse(await fs.readFile(harness.configPath, 'utf8'));
    assert.strictEqual(
      persisted.session,
      null,
      '--no-persist-session must not persist a SIGNED_OUT recovery rotation',
    );
  } finally {
    await harness.cleanup();
  }
  console.log('✅ no-persist SIGNED_OUT recovery stays sessionless');
}

async function testShutdownWaitsForSignedOutRecoveryPersistence() {
  const harness = await createHarness(true);
  try {
    await seedOldSession(harness);
    const renewed = {
      access_token: 'SYNTHETIC_ACCESS_SHUTDOWN_RECOVERED',
      refresh_token: 'SYNTHETIC_REFRESH_SHUTDOWN_RECOVERED',
    };
    harness.setRefreshSessionResult(renewed);
    harness.holdRefreshSession();
    harness.remote.setOffline = async () => {};
    harness.device.desktop.shutdown = async () => {};

    harness.emit('SIGNED_OUT', null);
    await harness.waitForRefreshCall();

    let settled = false;
    const shutdown = harness.device.shutdown().then(() => { settled = true; });
    await new Promise((resolve) => setTimeout(resolve, 25));
    assert.strictEqual(
      settled,
      false,
      'shutdown must wait for in-flight SIGNED_OUT recovery before flushing persistence',
    );

    harness.releaseRefreshSession();
    await shutdown;

    const persisted = JSON.parse(await fs.readFile(harness.configPath, 'utf8'));
    assert.strictEqual(persisted.session?.refresh_token, renewed.refresh_token);
    assert.strictEqual(persisted.session?.access_token, renewed.access_token);
  } finally {
    harness.releaseRefreshSession();
    await harness.cleanup();
  }
  console.log('✅ shutdown waits for SIGNED_OUT recovery persistence');
}

async function testPersistenceFailureIsFatalToShutdown() {
  const harness = await createHarness(true);
  try {
    await seedOldSession(harness);
    const blocker = path.join(harness.tempDir, 'not-a-directory');
    await fs.writeFile(blocker, 'block');
    harness.device.configPath = path.join(blocker, 'device.json');
    harness.remote.setOffline = async () => {};
    let desktopShutdownCalled = false;
    harness.device.desktop.shutdown = async () => { desktopShutdownCalled = true; };

    const rotated = {
      access_token: 'SYNTHETIC_ACCESS_WRITE_FAILURE',
      refresh_token: 'SYNTHETIC_REFRESH_WRITE_FAILURE',
    };
    harness.setCurrentSession(rotated);
    harness.emit('TOKEN_REFRESHED', rotated);

    await assert.rejects(
      harness.device.shutdown(),
      /EEXIST|ENOTDIR|not a directory/i,
      'shutdown must surface a failed session persistence write',
    );
    assert.strictEqual(
      desktopShutdownCalled,
      false,
      'shutdown must not report completion after persistence failure',
    );
  } finally {
    await harness.cleanup();
  }
  console.log('✅ persistence failure is fatal to graceful shutdown');
}

async function testShutdownWaitsForPendingPersistence() {
  const harness = await createHarness(true);
  let releasePersist;
  try {
    harness.device.sessionPersistChain = new Promise((resolve) => { releasePersist = resolve; });
    harness.remote.stopHeartbeat = () => {};
    harness.remote.unsubscribe = async () => {};
    harness.remote.setOffline = async () => {};
    harness.device.desktop.shutdown = async () => {};

    let settled = false;
    const shutdownPromise = harness.device.shutdown().then(() => { settled = true; });
    await new Promise((resolve) => setTimeout(resolve, 25));
    assert.strictEqual(settled, false, 'shutdown must wait for pending session persistence');
    releasePersist();
    await shutdownPromise;
  } finally {
    releasePersist?.();
    await harness.cleanup();
  }
  console.log('✅ shutdown waits for pending session persistence');
}

async function main() {
  await testRotatedSessionPersists();
  await testNoPersistModeStaysSessionless();
  await testRapidRotationsKeepNewestSession();
  await testSignedOutRecoveryPersistsRenewedSession();
  await testNoPersistSignedOutRecoveryStaysSessionless();
  await testShutdownWaitsForSignedOutRecoveryPersistence();
  await testPersistenceFailureIsFatalToShutdown();
  await testShutdownWaitsForPendingPersistence();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
