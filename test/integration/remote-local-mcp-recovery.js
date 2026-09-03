import assert from 'node:assert/strict';
import { DesktopCommanderIntegration } from '../../dist/remote-device/desktop-commander-integration.js';

process.env.DESKTOP_COMMANDER_DISABLE_TELEMETRY = '1';

const integration = new DesktopCommanderIntegration();
await integration.initialize();
assert.equal(integration.ready, true, 'real local MCP must start ready');

const firstClient = integration.mcpClient;
const firstTransport = integration.mcpTransport;
assert.ok(firstClient && firstTransport, 'real client and transport must exist');

await firstTransport.close();
await new Promise(r => setTimeout(r, 100));
assert.equal(integration.ready, false,
  'unexpected stdio close must invalidate readiness');

await integration.ensureReady();
assert.equal(integration.ready, true, 'ensureReady must recreate local MCP');
assert.notEqual(integration.mcpClient, firstClient,
  'recovery must use a new client generation');

const tools = await integration.listClientTools();
assert.ok(tools.tools.length > 0, 'recovered local MCP must answer tools/list');
await integration.shutdown();
console.log('✓ real local MCP stdio loss self-recovers');
