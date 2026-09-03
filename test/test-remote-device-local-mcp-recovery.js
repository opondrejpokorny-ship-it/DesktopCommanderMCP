import assert from 'node:assert/strict';
import { MCPDevice } from '../dist/remote-device/device.js';

process.env.DESKTOP_COMMANDER_DISABLE_TELEMETRY = '1';

const device = new MCPDevice();
const statuses = [];
device.deviceId = 'device-test';
device.remoteChannel = {
  setOnlineStatus: async (_id, status) => { statuses.push(status); }
};
let recoveries = 0;
device.desktop = {
  ensureReady: async () => { recoveries += 1; }
};

assert.equal(typeof device.handleLocalMcpLoss, 'function',
  'device must react to unexpected local MCP loss');
await device.handleLocalMcpLoss('stdio closed');

assert.deepEqual(statuses, ['offline', 'online'],
  'device must stay offline until local MCP recovery succeeds');
assert.equal(recoveries, 1, 'device must proactively recover once');
console.log('✓ device gates online status on local MCP recovery');
