import {
    listAuditEvents,
    type AuditEvent,
} from '../policy/audit-store.js';
import { loadRemoteDeviceIdentity } from '../policy/device-identity.js';
import { setPolicyDeviceId } from '../policy/policy-runtime.js';
import type {
    ControlCenterExtensionV1,
    ControlCenterJsonResponseV1,
    ControlCenterRequestContextV1,
} from './contract.js';

const TEAM_AUDIT_LIMIT = 200;

function sanitizeAuditEvent(event: AuditEvent) {
    return {
        id: event.id,
        timestamp: event.timestamp,
        type: event.type,
        requestId: event.requestId,
        tool: event.tool,
        ...(event.action ? { action: event.action } : {}),
        ...(event.deviceId ? { deviceId: event.deviceId } : {}),
        ...(event.decision ? { decision: event.decision } : {}),
        ...(event.ruleId ? { ruleId: event.ruleId } : {}),
        ...(event.approvalRequestId ? { approvalRequestId: event.approvalRequestId } : {}),
        ...(event.approvalDecision ? { approvalDecision: event.approvalDecision } : {}),
        ...(event.outcome ? { outcome: event.outcome } : {}),
        ...(Number.isFinite(event.durationMs) ? { durationMs: event.durationMs } : {}),
    };
}

async function handleGetDevice(): Promise<ControlCenterJsonResponseV1> {
    return {
        status: 200,
        body: { detectedDeviceIdentity: await loadRemoteDeviceIdentity() },
    };
}

async function handleSetDevice(
    context: ControlCenterRequestContextV1,
): Promise<ControlCenterJsonResponseV1> {
    const body = await context.readJsonBody();
    if (!body || typeof body !== 'object') {
        return { status: 400, body: { error: 'Invalid device request.' } };
    }
    const deviceId = (body as Record<string, unknown>).deviceId;
    if (typeof deviceId !== 'string' || !deviceId.trim()) {
        return { status: 400, body: { error: 'Invalid device ID.' } };
    }
    try {
        const policy = await setPolicyDeviceId(deviceId.trim());
        return { status: 200, body: { deviceId: policy.deviceId } };
    } catch {
        return { status: 400, body: { error: 'Invalid device ID.' } };
    }
}

async function handleGetAudit(): Promise<ControlCenterJsonResponseV1> {
    const auditEvents = await listAuditEvents(undefined, TEAM_AUDIT_LIMIT);
    return {
        status: 200,
        body: { auditEvents: auditEvents.map(sanitizeAuditEvent) },
    };
}

const TEAM_HTML = `
<section id="dc-team-root">
  <h2>Team controls</h2>
  <p id="dc-team-status">Loading...</p>
  <h3>Remote device</h3>
  <p>Detected: <strong id="dc-team-detected-device">Not detected</strong></p>
  <label>Policy device <input id="dc-team-device-id" placeholder="Device ID"></label>
  <button id="dc-team-save-device">Use this device</button>
  <h3>Recent audit</h3>
  <ul id="dc-team-audit"></ul>
</section>`;
const TEAM_SCRIPT = `
(() => {
  const api = window.dcControlCenter.api;
  const byId = (id) => document.getElementById(id);
  const status = byId('dc-team-status');
  function auditText(event) {
    const decision = event.decision ? ' - ' + event.decision : '';
    const outcome = event.outcome ? ' - ' + event.outcome : '';
    return event.timestamp + ' - ' + event.type + ' - ' + event.tool + decision + outcome;
  }
  async function refresh() {
    const [device, audit] = await Promise.all([
      api('/api/team/device'),
      api('/api/team/audit')
    ]);
    const detected = device.detectedDeviceIdentity;
    byId('dc-team-detected-device').textContent = detected ? detected.deviceId : 'Not detected';
    if (detected && !byId('dc-team-device-id').value) {
      byId('dc-team-device-id').value = detected.deviceId;
    }
    const list = byId('dc-team-audit');
    list.replaceChildren();
    for (const event of audit.auditEvents) {
      const item = document.createElement('li');
      item.textContent = auditText(event);
      list.append(item);
    }
    status.textContent = 'Ready';
  }
  byId('dc-team-save-device').addEventListener('click', async () => {
    try {
      status.textContent = 'Saving device policy...';
      await api('/api/team/device', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ deviceId: byId('dc-team-device-id').value })
      });
      await refresh();
    } catch (error) {
      status.textContent = error instanceof Error ? error.message : String(error);
    }
  });
  refresh().catch((error) => {
    status.textContent = error instanceof Error ? error.message : String(error);
  });
})();`;

export function createTeamControlCenterExtension(): ControlCenterExtensionV1 {
    const deviceCapability = ['team.device_policy'] as const;
    const auditCapability = ['audit.local'] as const;
    return {
        id: 'team',
        apiPrefixes: ['/api/team'],
        requiredCapabilities: ['team.device_policy', 'audit.local'],
        routes: [
            {
                method: 'GET', apiPrefix: '/api/team', path: '/device',
                requiredCapabilities: deviceCapability,
                handle: handleGetDevice,
            },
            {
                method: 'POST', apiPrefix: '/api/team', path: '/device',
                requiredCapabilities: deviceCapability,
                handle: handleSetDevice,
            },
            {
                method: 'GET', apiPrefix: '/api/team', path: '/audit',
                requiredCapabilities: auditCapability,
                handle: handleGetAudit,
            },
        ],
        ui: {
            viewId: 'team-controls',
            label: 'Team controls',
            html: TEAM_HTML,
            script: TEAM_SCRIPT,
        },
    };
}
