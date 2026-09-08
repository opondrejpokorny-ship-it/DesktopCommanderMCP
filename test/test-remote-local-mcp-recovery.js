import assert from 'node:assert/strict';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { getDefaultEnvironment } from '@modelcontextprotocol/sdk/client/stdio.js';
import * as desktopCommanderIntegrationModule from '../dist/remote-device/desktop-commander-integration.js';

const {
  DesktopCommanderIntegration,
  buildDesktopCommanderChildEnvironment
} = desktopCommanderIntegrationModule;

process.env.DESKTOP_COMMANDER_DISABLE_TELEMETRY = '1';

const approvedStateEnvironment = {
  DESKTOP_COMMANDER_POLICY_FILE: 'parent-policy-marker',
  DESKTOP_COMMANDER_APPROVAL_FILE: 'parent-approval-marker',
  DESKTOP_COMMANDER_AUDIT_FILE: 'parent-audit-marker',
  DESKTOP_COMMANDER_USAGE_FILE: 'parent-usage-marker',
  DESKTOP_COMMANDER_WORKFLOW_STATE_DIR: 'parent-workflow-marker'
};

const forbiddenParentEnvironment = {
  DESKTOP_COMMANDER_REMOTE_DEVICE_CONFIG_FILE: 'forbidden-remote-config-marker',
  DESKTOP_COMMANDER_ARBITRARY_MARKER: 'forbidden-desktop-commander-marker',
  OPENAI_API_KEY: 'forbidden-secret-marker',
  RDC_ARBITRARY_PROCESS_ENV: 'forbidden-process-marker'
};

async function withTemporaryEnvironment(values, operation) {
  const originalValues = new Map(
    Object.keys(values).map(key => [key, process.env[key]])
  );

  try {
    Object.assign(process.env, values);
    return await operation();
  } finally {
    for (const [key, value] of originalValues) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

async function initializeForwardsOnlyApprovedParentStateEnvironment() {
  await withTemporaryEnvironment({
    ...approvedStateEnvironment,
    ...forbiddenParentEnvironment
  }, async () => {
    const originalConnect = Client.prototype.connect;
    const originalListTools = Client.prototype.listTools;
    let childEnvironment;

    Client.prototype.connect = async function (transport) {
      childEnvironment = transport._serverParams.env;
    };
    Client.prototype.listTools = async () => ({ tools: [] });

    try {
      const integration = new DesktopCommanderIntegration();
      integration.resolveMcpConfig = async () => ({
        command: process.execPath,
        args: [],
        env: {
          DESKTOP_COMMANDER_POLICY_FILE: 'config-policy-marker',
          CONFIG_ONLY_MARKER: 'config-only-marker',
          DC_REMOTE_DEVICE: 'false'
        }
      });

      await integration.initialize();

      assert.ok(childEnvironment, 'initialize must provide an explicit child environment');
      assert.equal(childEnvironment.DESKTOP_COMMANDER_POLICY_FILE, 'config-policy-marker',
        'explicit config.env must override forwarded parent state');
      for (const [key, value] of Object.entries(approvedStateEnvironment)) {
        if (key === 'DESKTOP_COMMANDER_POLICY_FILE') continue;
        assert.equal(childEnvironment[key], value, `${key} must be forwarded`);
      }
      assert.equal(childEnvironment.CONFIG_ONLY_MARKER, 'config-only-marker',
        'explicit config.env values must be preserved');
      assert.equal(childEnvironment.DC_REMOTE_DEVICE, 'true',
        'DC_REMOTE_DEVICE must be forced true after config.env');

      for (const key of Object.keys(forbiddenParentEnvironment)) {
        assert.equal(Object.hasOwn(childEnvironment, key), false,
          `${key} must not be forwarded from the parent`);
      }

      for (const [key, value] of Object.entries(getDefaultEnvironment())) {
        assert.equal(childEnvironment[key], value, `${key} safe default must be preserved`);
      }
    } finally {
      Client.prototype.connect = originalConnect;
      Client.prototype.listTools = originalListTools;
    }
  });
}

async function childEnvironmentCompositionIsDirectlyTestable() {
  await withTemporaryEnvironment({
    ...approvedStateEnvironment,
    ...forbiddenParentEnvironment
  }, async () => {
    assert.equal(typeof buildDesktopCommanderChildEnvironment, 'function',
      'child environment composition must be exposed as a pure helper');

    const childEnvironment = buildDesktopCommanderChildEnvironment(
      { SAFE_DEFAULT_MARKER: 'safe-default-marker' },
      process.env,
      {
        DESKTOP_COMMANDER_POLICY_FILE: 'config-policy-marker',
        DC_REMOTE_DEVICE: 'false'
      }
    );

    assert.equal(childEnvironment.SAFE_DEFAULT_MARKER, 'safe-default-marker');
    assert.equal(childEnvironment.DESKTOP_COMMANDER_POLICY_FILE, 'config-policy-marker');
    assert.equal(childEnvironment.DESKTOP_COMMANDER_APPROVAL_FILE, 'parent-approval-marker');
    assert.equal(childEnvironment.DC_REMOTE_DEVICE, 'true');
    for (const key of Object.keys(forbiddenParentEnvironment)) {
      assert.equal(Object.hasOwn(childEnvironment, key), false,
        `${key} must not be forwarded by the helper`);
    }
  });
}

await initializeForwardsOnlyApprovedParentStateEnvironment();
console.log('child environment forwards only approved parent state');
await childEnvironmentCompositionIsDirectlyTestable();
console.log('child environment composition is directly testable');

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
