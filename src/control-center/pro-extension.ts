import type { AuditSink } from '../policy/audit-sink.js';
import {
    listApprovals,
    setApprovalDecision,
    type ApprovalRecord,
} from '../policy/approval-store.js';
import {
    isAbsolutePolicyPath,
    isCommandPermission,
    isFolderPermission,
    isPolicyProfile,
    listCommandPermissions,
    listFolderPermissions,
    loadPolicyRuntimeConfig,
    setCommandPermission,
    setFolderPermission,
    setPolicyProfile,
    type PolicyRuntimeConfig,
} from '../policy/policy-runtime.js';
import type {
    ControlCenterExtensionV1,
    ControlCenterJsonResponseV1,
    ControlCenterRequestContextV1,
} from './contract.js';

export interface ProControlCenterExtensionOptions {
    auditSink?: AuditSink;
}
function sanitizeProPolicy(policy: PolicyRuntimeConfig) {
    return {
        version: policy.version,
        tier: policy.tier,
        ...(policy.profile ? { profile: policy.profile } : {}),
        rules: policy.rules
            .filter((rule) => !rule.deviceId)
            .map(({ deviceId: _deviceId, ...rule }) => ({ ...rule })),
    };
}

function sanitizeApproval(record: ApprovalRecord) {
    return {
        id: record.id,
        tool: record.tool,
        ...(record.ruleId ? { ruleId: record.ruleId } : {}),
        ...(record.resource ? { resource: record.resource } : {}),
        ...(record.action ? { action: record.action } : {}),
        status: record.status,
        createdAt: record.createdAt,
        expiresAt: record.expiresAt,
        ...(record.decidedAt ? { decidedAt: record.decidedAt } : {}),
        ...(record.consumedAt ? { consumedAt: record.consumedAt } : {}),
    };
}

async function buildProState() {
    const policy = await loadPolicyRuntimeConfig();
    const approvals = await listApprovals();
    const proPolicy = sanitizeProPolicy(policy);
    const globalPolicy: PolicyRuntimeConfig = {
        ...policy,
        rules: policy.rules.filter((rule) => !rule.deviceId),
    };
    delete globalPolicy.deviceId;
    return {
        policy: proPolicy,
        folderPermissions: listFolderPermissions(globalPolicy),
        commandPermissions: listCommandPermissions(globalPolicy),
        pendingApprovals: approvals
            .filter((record) => record.status === 'pending')
            .map(sanitizeApproval),
    };
}

function invalidRequest(error: string): ControlCenterJsonResponseV1 {
    return { status: 400, body: { error } };
}

async function handleProfile(
    context: ControlCenterRequestContextV1,
): Promise<ControlCenterJsonResponseV1> {
    const profile = context.params.profile;
    if (!isPolicyProfile(profile)) return invalidRequest('Invalid policy profile.');
    const policy = await setPolicyProfile(profile);
    return { status: 200, body: sanitizeProPolicy(policy) };
}
async function handleFolders(
    context: ControlCenterRequestContextV1,
): Promise<ControlCenterJsonResponseV1> {
    const body = await context.readJsonBody();
    if (!body || typeof body !== 'object') {
        return invalidRequest('Invalid folder permission request.');
    }
    const input = body as Record<string, unknown>;
    if (input.deviceId !== undefined) {
        return invalidRequest('Device-scoped policy requires Team controls.');
    }
    if (
        typeof input.path !== 'string' ||
        !isAbsolutePolicyPath(input.path) ||
        typeof input.permission !== 'string' ||
        !isFolderPermission(input.permission)
    ) {
        return invalidRequest('Invalid folder permission.');
    }
    const policy = await setFolderPermission(input.path, input.permission);
    const globalPolicy: PolicyRuntimeConfig = {
        ...policy,
        rules: policy.rules.filter((rule) => !rule.deviceId),
    };
    delete globalPolicy.deviceId;
    return {
        status: 200,
        body: {
            policy: sanitizeProPolicy(policy),
            folderPermissions: listFolderPermissions(globalPolicy),
        },
    };
}

async function handleCommands(
    context: ControlCenterRequestContextV1,
): Promise<ControlCenterJsonResponseV1> {
    const body = await context.readJsonBody();
    if (!body || typeof body !== 'object') {
        return invalidRequest('Invalid command permission request.');
    }
    const input = body as Record<string, unknown>;
    if (input.deviceId !== undefined) {
        return invalidRequest('Device-scoped policy requires Team controls.');
    }
    if (
        typeof input.commandPrefix !== 'string' ||
        !input.commandPrefix.trim() ||
        typeof input.permission !== 'string' ||
        !isCommandPermission(input.permission)
    ) {
        return invalidRequest('Invalid command permission.');
    }
    try {
        const policy = await setCommandPermission(input.commandPrefix, input.permission);
        const globalPolicy: PolicyRuntimeConfig = {
            ...policy,
            rules: policy.rules.filter((rule) => !rule.deviceId),
        };
        delete globalPolicy.deviceId;
        return {
            status: 200,
            body: {
                policy: sanitizeProPolicy(policy),
                commandPermissions: listCommandPermissions(globalPolicy),
            },
        };
    } catch {
        return invalidRequest('Invalid command permission.');
    }
}

async function handleApproval(
    context: ControlCenterRequestContextV1,
    decision: 'approved' | 'denied',
    auditSink?: AuditSink,
): Promise<ControlCenterJsonResponseV1> {
    const record = await setApprovalDecision(
        context.params.id,
        decision,
        undefined,
        auditSink,
    );
    if (!record) {
        return {
            status: 404,
            body: { error: 'Approval request was not found, expired, or is not pending.' },
        };
    }
    return { status: 200, body: sanitizeApproval(record) };
}

const PRO_HTML = `
<section id="dc-pro-root">
  <h2>Pro controls</h2>
  <p id="dc-pro-status">Loading...</p>
  <label>Profile <select id="dc-pro-profile">
    <option value="full_access">Full Access</option>
    <option value="safe_developer">Safe Developer</option>
    <option value="read_only">Read Only</option>
  </select></label>
  <button id="dc-pro-save-profile">Save profile</button>
  <h3>Folder policy</h3>
  <input id="dc-pro-folder-path" placeholder="Absolute folder path">
  <select id="dc-pro-folder-permission">
    <option value="read_write">Read/write</option>
    <option value="read_only">Read only</option>
    <option value="approval_required">Approval required</option>
    <option value="blocked">Blocked</option>
    <option value="inherit">Inherit</option>
  </select>
  <button id="dc-pro-save-folder">Save folder</button>
  <ul id="dc-pro-folders"></ul>
  <h3>Command policy</h3>
  <input id="dc-pro-command-prefix" placeholder="Command prefix">
  <select id="dc-pro-command-permission">
    <option value="allow">Allow</option>
    <option value="approval_required">Approval required</option>
    <option value="blocked">Blocked</option>
    <option value="inherit">Inherit</option>
  </select>
  <button id="dc-pro-save-command">Save command</button>
  <ul id="dc-pro-commands"></ul>
  <h3>Pending approvals</h3>
  <ul id="dc-pro-approvals"></ul>
</section>`;

const PRO_SCRIPT = `
(() => {
  const api = window.dcControlCenter.api;
  const byId = (id) => document.getElementById(id);
  const status = byId('dc-pro-status');
  function listText(targetId, values, formatter) {
    const target = byId(targetId);
    target.replaceChildren();
    for (const value of values) {
      const item = document.createElement('li');
      item.textContent = formatter(value);
      target.append(item);
    }
  }
  function approvalText(record) {
    const resource = record.resource ? ' - ' + record.resource : '';
    return record.tool + resource + ' (expires ' + record.expiresAt + ')';
  }
  async function post(path, body) {
    return api(path, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      ...(body === undefined ? {} : { body: JSON.stringify(body) })
    });
  }
  async function refresh() {
    const state = await api('/api/pro/state');
    byId('dc-pro-profile').value = state.policy.profile || 'full_access';
    listText('dc-pro-folders', state.folderPermissions, (entry) =>
      entry.path + ': ' + entry.permission);
    listText('dc-pro-commands', state.commandPermissions, (entry) =>
      entry.commandPrefix + ': ' + entry.permission);
    const approvals = byId('dc-pro-approvals');
    approvals.replaceChildren();
    for (const record of state.pendingApprovals) {
      const item = document.createElement('li');
      const label = document.createElement('span');
      label.textContent = approvalText(record);
      item.append(label);
      for (const decision of ['approve', 'deny']) {
        const button = document.createElement('button');
        button.textContent = decision === 'approve' ? 'Approve' : 'Deny';
        button.addEventListener('click', async () => {
          try {
            status.textContent = decision === 'approve' ? 'Approving...' : 'Denying...';
            await post('/api/pro/approvals/' + encodeURIComponent(record.id) + '/' + decision);
            await refresh();
          } catch (error) {
            status.textContent = error instanceof Error ? error.message : String(error);
          }
        });
        item.append(button);
      }
      approvals.append(item);
    }
    status.textContent = 'Ready';
  }
  byId('dc-pro-save-profile').addEventListener('click', async () => {
    try {
      status.textContent = 'Saving profile...';
      await post('/api/pro/profile/' + encodeURIComponent(byId('dc-pro-profile').value));
      await refresh();
    } catch (error) {
      status.textContent = error instanceof Error ? error.message : String(error);
    }
  });
  byId('dc-pro-save-folder').addEventListener('click', async () => {
    try {
      status.textContent = 'Saving folder policy...';
      await post('/api/pro/folders', {
        path: byId('dc-pro-folder-path').value,
        permission: byId('dc-pro-folder-permission').value
      });
      await refresh();
    } catch (error) {
      status.textContent = error instanceof Error ? error.message : String(error);
    }
  });
  byId('dc-pro-save-command').addEventListener('click', async () => {
    try {
      status.textContent = 'Saving command policy...';
      await post('/api/pro/commands', {
        commandPrefix: byId('dc-pro-command-prefix').value,
        permission: byId('dc-pro-command-permission').value
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

export function createProControlCenterExtension(
    options: ProControlCenterExtensionOptions = {},
): ControlCenterExtensionV1 {
    const policyCapability = ['policy.config'] as const;
    const approvalCapability = ['approvals.local'] as const;
    return {
        id: 'pro',
        apiPrefixes: ['/api/pro'],
        requiredCapabilities: ['policy.config', 'approvals.local'],
        routes: [
            {
                method: 'GET',
                apiPrefix: '/api/pro',
                path: '/state',
                requiredCapabilities: policyCapability,
                async handle() {
                    return { status: 200, body: await buildProState() };
                },
            },
            {
                method: 'POST',
                apiPrefix: '/api/pro',
                path: '/profile/:profile',
                requiredCapabilities: policyCapability,
                handle: handleProfile,
            },
            {
                method: 'POST',
                apiPrefix: '/api/pro',
                path: '/folders',
                requiredCapabilities: policyCapability,
                handle: handleFolders,
            },
            {
                method: 'POST',
                apiPrefix: '/api/pro',
                path: '/commands',
                requiredCapabilities: policyCapability,
                handle: handleCommands,
            },
            {
                method: 'POST',
                apiPrefix: '/api/pro',
                path: '/approvals/:id/approve',
                requiredCapabilities: approvalCapability,
                handle: (context) => handleApproval(context, 'approved', options.auditSink),
            },
            {
                method: 'POST',
                apiPrefix: '/api/pro',
                path: '/approvals/:id/deny',
                requiredCapabilities: approvalCapability,
                handle: (context) => handleApproval(context, 'denied', options.auditSink),
            },
        ],
        ui: {
            viewId: 'pro-controls',
            label: 'Pro controls',
            html: PRO_HTML,
            script: PRO_SCRIPT,
        },
    };
}
