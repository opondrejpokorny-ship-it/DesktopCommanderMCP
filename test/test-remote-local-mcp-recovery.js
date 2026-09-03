import assert from 'node:assert/strict';
import { DesktopCommanderIntegration } from '../dist/remote-device/desktop-commander-integration.js';

process.env.DESKTOP_COMMANDER_DISABLE_TELEMETRY = '1';

async function transportFailureInvalidatesWithoutReplay() {
  const integration = new DesktopCommanderIntegration();
  let calls = 0;
  integration.isReady = true;
  integration.mcpClient = { callTool: async () => {
    calls += 1;
    throw new Error('Not connected');
  }};

  await assert.rejects(
    () => integration.callClientTool('write_file', { path: 'x', content: 'y' }),
    /Not connected/
  );
  assert.equal(calls, 1, 'ambiguous side effect must never be replayed');
  assert.equal(integration.ready, false, 'transport failure must invalidate readiness');
}

async function concurrentRecoveryIsSingleFlight() {
  const recovery = new DesktopCommanderIntegration();
  let starts = 0;
  recovery.initialize = async () => {
    starts += 1;
    await new Promise(r => setTimeout(r, 30));
    recovery.isReady = true;
    recovery.mcpClient = {};
  };
  assert.equal(typeof recovery.ensureReady, 'function', 'ensureReady must exist');
  await Promise.all([recovery.ensureReady(), recovery.ensureReady(), recovery.ensureReady()]);
  assert.equal(starts, 1, 'concurrent recovery must spawn only once');
}

async function brokenToolProbeFailsClosed() {
  const integration = new DesktopCommanderIntegration();
  integration.isReady = true;
  integration.mcpClient = {
    listTools: async () => { throw new Error('Connection closed'); }
  };

  await assert.rejects(() => integration.listClientTools(), /Connection closed/);
  assert.equal(integration.ready, false,
    'failed readiness probe must invalidate execution readiness');
}

async function staleGenerationCannotKillRecoveredBridge() {
  const integration = new DesktopCommanderIntegration();
  integration.connectionGeneration = 2;
  integration.isReady = true;
  integration.mcpClient = {};

  assert.equal(typeof integration.handleLocalDisconnect, 'function',
    'generation-aware disconnect handler must exist');
  integration.handleLocalDisconnect('old transport closed', 1);
  assert.equal(integration.ready, true,
    'old generation close must not invalidate current connection');
}
await transportFailureInvalidatesWithoutReplay();
console.log('✓ transport failure invalidates without replaying side effects');
await concurrentRecoveryIsSingleFlight();
console.log('✓ concurrent recovery is single-flight');
await brokenToolProbeFailsClosed();
console.log('✓ broken tool probe fails closed');
await staleGenerationCannotKillRecoveredBridge();
console.log('✓ stale generation cannot kill recovered bridge');

async function lateOldToolFailureCannotKillRecoveredBridge() {
  const integration = new DesktopCommanderIntegration();
  let rejectOld;
  integration.connectionGeneration = 1;
  integration.isReady = true;
  integration.mcpClient = {
    callTool: () => new Promise((_, reject) => { rejectOld = reject; })
  };

  const oldCall = integration.callClientTool('write_file', { path: 'x', content: 'y' });
  await new Promise(resolve => setTimeout(resolve, 0));
  integration.handleLocalDisconnect('old transport closed', 1);
  integration.isReady = true;
  integration.mcpClient = { callTool: async () => ({ content: [] }) };
  const recoveredClient = integration.mcpClient;

  rejectOld(new Error('Not connected'));
  await assert.rejects(() => oldCall, /Not connected/);
  assert.equal(integration.ready, true,
    'late failure from old generation must not invalidate recovered bridge');
  assert.equal(integration.mcpClient, recoveredClient,
    'late failure must not replace the recovered client');
}

await lateOldToolFailureCannotKillRecoveredBridge();
console.log('✓ late old tool failure cannot kill recovered bridge');

async function lateOldListFailureCannotKillRecoveredBridge() {
  const integration = new DesktopCommanderIntegration();
  let rejectOld;
  integration.connectionGeneration = 1;
  integration.isReady = true;
  integration.mcpClient = {
    listTools: () => new Promise((_, reject) => { rejectOld = reject; })
  };

  const oldList = integration.listClientTools();
  await new Promise(resolve => setTimeout(resolve, 0));
  integration.handleLocalDisconnect('old transport closed', 1);
  integration.isReady = true;
  integration.mcpClient = { listTools: async () => ({ tools: [{ name: 'read_file' }] }) };
  const recoveredClient = integration.mcpClient;

  rejectOld(new Error('Connection closed'));
  await assert.rejects(() => oldList, /Connection closed/);
  assert.equal(integration.ready, true,
    'late list failure from old generation must not invalidate recovered bridge');
  assert.equal(integration.mcpClient, recoveredClient,
    'late list failure must not replace recovered client');
}

await lateOldListFailureCannotKillRecoveredBridge();
console.log('✓ late old list failure cannot kill recovered bridge');

async function failedGenerationResourcesAreClosed() {
  const integration = new DesktopCommanderIntegration();
  let clientCloses = 0;
  let transportCloses = 0;
  const client = { close: async () => { clientCloses += 1; } };
  const transport = { close: async () => { transportCloses += 1; } };

  assert.equal(typeof integration.closeGenerationResources, 'function',
    'failed connection generation must have bounded cleanup');
  await integration.closeGenerationResources(client, transport);
  assert.equal(clientCloses, 1, 'failed generation client must close');
  assert.equal(transportCloses, 1, 'failed generation transport must close');
}

await failedGenerationResourcesAreClosed();
console.log('✓ failed connection generation resources are closed');
