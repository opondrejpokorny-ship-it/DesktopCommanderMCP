import crypto from 'node:crypto';
import http, {
    IncomingMessage,
    Server,
    ServerResponse,
} from 'node:http';
import { AddressInfo } from 'node:net';
import {
    listApprovals,
    setApprovalDecision,
} from '../policy/approval-store.js';
import { listAuditEvents } from '../policy/audit-store.js';
import { loadRemoteDeviceIdentity } from '../policy/device-identity.js';
import {
    isAbsolutePolicyPath,
    isCommandPermission,
    isDesktopCommanderTier,
    isFolderPermission,
    isPolicyProfile,
    listCommandPermissions,
    listFolderPermissions,
    loadPolicyRuntimeConfig,
    setCommandPermission,
    setFolderPermission,
    setPolicyDeviceId,
    setPolicyProfile,
    setPolicyTier,
} from '../policy/policy-runtime.js';

export interface ControlCenterOptions {
    host?: '127.0.0.1' | 'localhost' | '::1';
    port?: number;
    token?: string;
    quiet?: boolean;
}

export interface RunningControlCenter {
    server: Server;
    host: string;
    port: number;
    token: string;
    url: string;
    close: () => Promise<void>;
}

const DEFAULT_HOST = '127.0.0.1';
const DEFAULT_PORT = 17831;
const API_TOKEN_HEADER = 'x-dc-control-token';

function setSecurityHeaders(response: ServerResponse): void {
    response.setHeader('Cache-Control', 'no-store');
    response.setHeader('X-Content-Type-Options', 'nosniff');
    response.setHeader('X-Frame-Options', 'DENY');
    response.setHeader('Referrer-Policy', 'no-referrer');
    response.setHeader('Cross-Origin-Resource-Policy', 'same-origin');
    response.setHeader(
        'Content-Security-Policy',
        [
            "default-src 'self'",
            "script-src 'unsafe-inline'",
            "style-src 'unsafe-inline'",
            "connect-src 'self'",
            "img-src 'self' data:",
            "frame-ancestors 'none'",
            "base-uri 'none'",
            "form-action 'self'",
        ].join('; '),
    );
}

function writeJson(
    response: ServerResponse,
    statusCode: number,
    value: unknown,
): void {
    setSecurityHeaders(response);
    response.statusCode = statusCode;
    response.setHeader('Content-Type', 'application/json; charset=utf-8');
    response.end(JSON.stringify(value));
}

function writeText(
    response: ServerResponse,
    statusCode: number,
    text: string,
    contentType: string = 'text/plain; charset=utf-8',
): void {
    setSecurityHeaders(response);
    response.statusCode = statusCode;
    response.setHeader('Content-Type', contentType);
    response.end(text);
}

function requestHeader(
    request: IncomingMessage,
    name: string,
): string | undefined {
    const value = request.headers[name];
    if (Array.isArray(value)) {
        return value[0];
    }
    return value;
}

function tokensMatch(provided: string | undefined, expected: string): boolean {
    if (!provided) {
        return false;
    }

    const left = Buffer.from(provided);
    const right = Buffer.from(expected);

    return left.length === right.length && crypto.timingSafeEqual(left, right);
}

function localHostnameFromHeader(value: string | undefined): string | null {
    if (!value) {
        return null;
    }

    try {
        return new URL(`http://${value}`).hostname.toLowerCase();
    } catch {
        return null;
    }
}

function isLoopbackHostname(hostname: string | null): boolean {
    return (
        hostname === '127.0.0.1' ||
        hostname === 'localhost' ||
        hostname === '::1' ||
        hostname === '[::1]'
    );
}

function hostHeaderIsLocal(request: IncomingMessage): boolean {
    return isLoopbackHostname(
        localHostnameFromHeader(request.headers.host),
    );
}

function mutationOriginIsLocal(request: IncomingMessage): boolean {
    const origin = requestHeader(request, 'origin');
    if (!origin) {
        return true;
    }

    try {
        return isLoopbackHostname(new URL(origin).hostname.toLowerCase());
    } catch {
        return false;
    }
}

async function readJsonBody(
    request: IncomingMessage,
    maxBytes: number = 8192,
): Promise<unknown> {
    const chunks: Buffer[] = [];
    let total = 0;

    for await (const chunk of request) {
        const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
        total += buffer.length;
        if (total > maxBytes) {
            throw new Error('Request body is too large');
        }
        chunks.push(buffer);
    }

    if (chunks.length === 0) {
        throw new Error('Request body is required');
    }

    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}

function renderControlCenterHtml(token: string): string {
    const serializedToken = JSON.stringify(token).replace(/</g, '\\u003c');

    return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <title>Desktop Commander Control Center</title>
  <style>
    :root { color-scheme: light dark; font-family: Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; }
    * { box-sizing: border-box; }
    body { margin: 0; min-height: 100vh; background: Canvas; color: CanvasText; }
    main { width: min(1180px, calc(100% - 32px)); margin: 0 auto; padding: 28px 0 48px; }
    header { display: flex; gap: 20px; align-items: center; justify-content: space-between; margin-bottom: 24px; }
    h1 { font-size: clamp(24px, 4vw, 38px); margin: 0; letter-spacing: -0.035em; }
    h2 { margin: 0 0 14px; font-size: 18px; }
    p { line-height: 1.5; }
    .subtle { opacity: .68; font-size: 13px; }
    .badge { border: 1px solid color-mix(in srgb, CanvasText 18%, transparent); border-radius: 999px; padding: 7px 11px; font-size: 12px; white-space: nowrap; }
    .grid { display: grid; grid-template-columns: repeat(12, 1fr); gap: 16px; }
    .card { border: 1px solid color-mix(in srgb, CanvasText 14%, transparent); border-radius: 16px; padding: 18px; background: color-mix(in srgb, Canvas 94%, CanvasText 6%); }
    .summary { grid-column: span 4; min-height: 122px; }
    .summary strong { display: block; font-size: 28px; margin-top: 10px; }
    .approvals { grid-column: span 7; }
    .audit { grid-column: span 5; }
    .policy { grid-column: span 12; }
    .row { border-top: 1px solid color-mix(in srgb, CanvasText 12%, transparent); padding: 13px 0; }
    .row:first-child { border-top: 0; padding-top: 0; }
    .row-title { font-weight: 650; overflow-wrap: anywhere; }
    .meta { opacity: .72; font-size: 12px; margin-top: 5px; overflow-wrap: anywhere; }
    .actions { display: flex; gap: 8px; margin-top: 10px; }
    button { border: 1px solid color-mix(in srgb, CanvasText 22%, transparent); border-radius: 10px; padding: 8px 12px; background: Canvas; color: CanvasText; cursor: pointer; font-weight: 600; }
    button:hover { background: color-mix(in srgb, Canvas 90%, CanvasText 10%); }
    button:disabled { opacity: .5; cursor: wait; }
    select, input { border: 1px solid color-mix(in srgb, CanvasText 22%, transparent); border-radius: 9px; padding: 7px 9px; background: Canvas; color: CanvasText; }
    select { margin-left: 6px; }
    input { min-width: min(440px, 100%); }
    .policy-controls { flex-wrap: wrap; margin-bottom: 10px; }
    .folder-editor { display: flex; gap: 8px; flex-wrap: wrap; align-items: center; margin: 14px 0; }
    .empty { opacity: .65; padding: 16px 0; }
    .status { min-height: 22px; margin: 0 0 12px; font-size: 13px; opacity: .8; }
    code { font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; font-size: 12px; }
    @media (max-width: 820px) {
      .summary, .approvals, .audit, .policy { grid-column: span 12; }
      header { align-items: flex-start; flex-direction: column; }
    }
  </style>
</head>
<body>
  <main>
    <header>
      <div>
        <div class="subtle">Local prototype · loopback only</div>
        <h1>Desktop Commander Control Center</h1>
      </div>
      <div class="badge" id="connection">Loading…</div>
    </header>

    <div class="grid">
      <section class="card summary"><span class="subtle">Tier</span><strong id="tier">—</strong><div class="subtle" id="profile">—</div></section>
      <section class="card summary"><span class="subtle">Pending approvals</span><strong id="pending-count">0</strong><div class="subtle">Exact, one-time approvals</div></section>
      <section class="card summary"><span class="subtle">Device</span><strong id="device">—</strong><div class="subtle">Team policy identity</div></section>

      <section class="card approvals">
        <h2>Pending approvals</h2>
        <p class="status" id="status"></p>
        <div id="approvals"></div>
      </section>

      <section class="card audit">
        <h2>Audit</h2>
        <div id="audit"></div>
      </section>

      <section class="card policy">
        <h2>Active policy</h2>
        <div class="actions policy-controls">
          <label class="subtle">Tier
            <select id="tier-select">
              <option value="free">Free</option>
              <option value="pro">Pro</option>
              <option value="team">Team</option>
            </select>
          </label>
          <label class="subtle">Profile
            <select id="profile-select">
              <option value="full_access">Full access</option>
              <option value="safe_developer">Safe developer</option>
              <option value="read_only">Read only</option>
            </select>
          </label>
        </div>
        <div id="policy"></div>
        <div class="folder-editor">
          <input id="folder-path" type="text" autocomplete="off" placeholder="/projects/production or C:\\Projects\\Production">
          <select id="folder-permission">
            <option value="read_write">Read / write</option>
            <option value="read_only">Read only</option>
            <option value="approval_required">Writes need approval</option>
            <option value="blocked">Blocked</option>
          </select>
          <button id="save-folder">Add folder rule</button>
        </div>
        <div id="folder-permissions"></div>
        <div class="folder-editor">
          <input id="command-prefix" type="text" autocomplete="off" placeholder="Command prefix, e.g. git push">
          <select id="command-permission">
            <option value="allow">Allow</option>
            <option value="approval_required">Require approval</option>
            <option value="blocked">Blocked</option>
          </select>
          <button id="save-command">Add command rule</button>
        </div>
        <div id="command-permissions"></div>
        <p class="subtle">Command rules are literal prefixes, not a shell sandbox. Raw terminal command text is not stored in approvals or audit records.</p>
      </section>
    </div>
  </main>

  <script>
    const TOKEN = ${serializedToken};

    function createElement(tag, text, className) {
      const element = document.createElement(tag);
      if (text !== undefined) element.textContent = text;
      if (className) element.className = className;
      return element;
    }

    async function api(path, options = {}) {
      const headers = new Headers(options.headers || {});
      headers.set('X-DC-Control-Token', TOKEN);
      const response = await fetch(path, { ...options, headers, cache: 'no-store' });
      if (!response.ok) {
        let message = 'Request failed (' + response.status + ')';
        try {
          const body = await response.json();
          if (body && body.error) message = body.error;
        } catch {}
        throw new Error(message);
      }
      return response.json();
    }

    function renderApprovals(items) {
      const root = document.getElementById('approvals');
      root.replaceChildren();

      if (!items.length) {
        root.appendChild(createElement('div', 'No pending approvals.', 'empty'));
        return;
      }

      for (const item of items) {
        const row = createElement('div', undefined, 'row');
        row.appendChild(createElement('div', item.tool, 'row-title'));
        row.appendChild(createElement(
          'div',
          item.resource || 'Sensitive resource details hidden',
          'meta'
        ));
        row.appendChild(createElement(
          'div',
          'Rule: ' + (item.ruleId || '—') + ' · expires ' + new Date(item.expiresAt).toLocaleTimeString(),
          'meta'
        ));

        const actions = createElement('div', undefined, 'actions');
        for (const decision of ['approve', 'deny']) {
          const button = createElement('button', decision === 'approve' ? 'Approve' : 'Deny');
          button.addEventListener('click', async () => {
            button.disabled = true;
            try {
              await api('/api/approvals/' + encodeURIComponent(item.id) + '/' + decision, { method: 'POST' });
              await refresh();
            } catch (error) {
              document.getElementById('status').textContent = error.message;
            } finally {
              button.disabled = false;
            }
          });
          actions.appendChild(button);
        }
        row.appendChild(actions);
        root.appendChild(row);
      }
    }

    function renderAudit(items) {
      const root = document.getElementById('audit');
      root.replaceChildren();

      if (!items.length) {
        root.appendChild(createElement('div', 'No audit events yet.', 'empty'));
        return;
      }

      for (const item of items.slice().reverse().slice(0, 18)) {
        const row = createElement('div', undefined, 'row');
        const outcome = item.approvalDecision || item.decision || item.outcome || item.type;
        row.appendChild(createElement('div', item.tool + ' · ' + outcome, 'row-title'));
        row.appendChild(createElement(
          'div',
          new Date(item.timestamp).toLocaleTimeString() + (item.resource ? ' · ' + item.resource : ''),
          'meta'
        ));
        root.appendChild(row);
      }
    }

    function renderFolderPermissions(items) {
      const root = document.getElementById('folder-permissions');
      root.replaceChildren();

      if (!items.length) {
        root.appendChild(createElement('div', 'No custom folder rules. Profile defaults apply.', 'empty'));
        return;
      }

      for (const item of items) {
        const row = createElement('div', undefined, 'row');
        row.appendChild(createElement('div', item.path, 'row-title'));
        row.appendChild(createElement('div', item.permission.replaceAll('_', ' '), 'meta'));
        const actions = createElement('div', undefined, 'actions');
        const remove = createElement('button', 'Use profile default');
        remove.addEventListener('click', async () => {
          await saveFolderPermission(item.path, 'inherit');
        });
        actions.appendChild(remove);
        row.appendChild(actions);
        root.appendChild(row);
      }
    }

    async function saveFolderPermission(pathValue, permission) {
      const status = document.getElementById('status');
      status.textContent = 'Saving folder policy…';
      try {
        await api('/api/policy/folders', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ path: pathValue, permission })
        });
        document.getElementById('folder-path').value = '';
        await refresh();
      } catch (error) {
        status.textContent = error.message;
      }
    }

    function renderCommandPermissions(items) {
      const root = document.getElementById('command-permissions');
      root.replaceChildren();

      if (!items.length) {
        root.appendChild(createElement('div', 'No custom command rules. Profile defaults apply.', 'empty'));
        return;
      }

      for (const item of items) {
        const row = createElement('div', undefined, 'row');
        row.appendChild(createElement('div', item.commandPrefix, 'row-title'));
        row.appendChild(createElement('div', item.permission.replaceAll('_', ' '), 'meta'));
        const actions = createElement('div', undefined, 'actions');
        const remove = createElement('button', 'Use profile default');
        remove.addEventListener('click', async () => {
          await saveCommandPermission(item.commandPrefix, 'inherit');
        });
        actions.appendChild(remove);
        row.appendChild(actions);
        root.appendChild(row);
      }
    }

    async function saveCommandPermission(commandPrefix, permission) {
      const status = document.getElementById('status');
      status.textContent = 'Saving command policy…';
      try {
        await api('/api/policy/commands', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ commandPrefix, permission })
        });
        document.getElementById('command-prefix').value = '';
        await refresh();
      } catch (error) {
        status.textContent = error.message;
      }
    }

    function renderPolicy(policy) {
      document.getElementById('tier-select').value = policy.tier || 'free';
      document.getElementById('profile-select').value = policy.profile || 'full_access';
      const root = document.getElementById('policy');
      root.replaceChildren();
      const lines = [
        ['Tier', policy.tier || 'free'],
        ['Profile', policy.profile || 'full_access'],
        ['Device', policy.deviceId || 'local'],
        ['Custom rules', String((policy.rules || []).length)],
      ];
      for (const [label, value] of lines) {
        const row = createElement('div', undefined, 'row');
        row.appendChild(createElement('div', label, 'subtle'));
        row.appendChild(createElement('code', value, 'row-title'));
        root.appendChild(row);
      }
    }

    async function changePolicy(kind, value) {
      const status = document.getElementById('status');
      status.textContent = 'Saving policy…';
      try {
        await api('/api/policy/' + kind + '/' + encodeURIComponent(value), { method: 'POST' });
        await refresh();
      } catch (error) {
        status.textContent = error.message;
        await refresh();
      }
    }

    document.getElementById('tier-select').addEventListener('change', (event) => {
      changePolicy('tier', event.target.value);
    });
    document.getElementById('profile-select').addEventListener('change', (event) => {
      changePolicy('profile', event.target.value);
    });
    document.getElementById('save-folder').addEventListener('click', () => {
      const pathValue = document.getElementById('folder-path').value.trim();
      const permission = document.getElementById('folder-permission').value;
      if (!pathValue) {
        document.getElementById('status').textContent = 'Enter an absolute folder path.';
        return;
      }
      saveFolderPermission(pathValue, permission);
    });
    document.getElementById('save-command').addEventListener('click', () => {
      const commandPrefix = document.getElementById('command-prefix').value.trim();
      const permission = document.getElementById('command-permission').value;
      if (!commandPrefix) {
        document.getElementById('status').textContent = 'Enter a command prefix.';
        return;
      }
      saveCommandPermission(commandPrefix, permission);
    });

    async function refresh() {
      const status = document.getElementById('status');
      try {
        const state = await api('/api/state');
        document.getElementById('tier').textContent = state.policy.tier || 'free';
        document.getElementById('profile').textContent = state.policy.profile || 'full_access';
        document.getElementById('device').textContent = state.policy.deviceId || 'local';
        document.getElementById('pending-count').textContent = String(state.pendingApprovals.length);
        document.getElementById('connection').textContent = 'Local · connected';
        status.textContent = '';
        renderApprovals(state.pendingApprovals);
        renderAudit(state.auditEvents);
        renderPolicy(state.policy);
        renderFolderPermissions(state.folderPermissions || []);
        renderCommandPermissions(state.commandPermissions || []);
      } catch (error) {
        document.getElementById('connection').textContent = 'Disconnected';
        status.textContent = error.message;
      }
    }

    refresh();
    setInterval(refresh, 2500);
  </script>
</body>
</html>`;
}

async function buildState(): Promise<Record<string, unknown>> {
    const [policy, approvals, auditEvents, detectedDeviceIdentity] =
        await Promise.all([
            loadPolicyRuntimeConfig(),
            listApprovals(),
            listAuditEvents(undefined, 100),
            loadRemoteDeviceIdentity(),
        ]);

    return {
        generatedAt: new Date().toISOString(),
        policy,
        detectedDeviceIdentity,
        folderPermissions: listFolderPermissions(policy),
        commandPermissions: listCommandPermissions(policy),
        pendingApprovals: approvals.filter((record) => record.status === 'pending'),
        auditEvents,
    };
}

export async function startControlCenter(
    options: ControlCenterOptions = {},
): Promise<RunningControlCenter> {
    const host = options.host ?? DEFAULT_HOST;
    const requestedPort = options.port ?? DEFAULT_PORT;
    const token = options.token ?? crypto.randomBytes(32).toString('base64url');

    const server = http.createServer(async (request, response) => {
        try {
            if (!hostHeaderIsLocal(request)) {
                writeJson(response, 400, { error: 'Invalid local Host header.' });
                return;
            }

            const requestUrl = new URL(
                request.url ?? '/',
                `http://${request.headers.host}`,
            );

            if (request.method === 'GET' && requestUrl.pathname === '/') {
                writeText(
                    response,
                    200,
                    renderControlCenterHtml(token),
                    'text/html; charset=utf-8',
                );
                return;
            }

            if (request.method === 'GET' && requestUrl.pathname === '/favicon.ico') {
                setSecurityHeaders(response);
                response.statusCode = 204;
                response.end();
                return;
            }

            if (!requestUrl.pathname.startsWith('/api/')) {
                writeJson(response, 404, { error: 'Not found.' });
                return;
            }

            if (!tokensMatch(requestHeader(request, API_TOKEN_HEADER), token)) {
                writeJson(response, 403, { error: 'Invalid Control Center session token.' });
                return;
            }

            if (request.method === 'GET' && requestUrl.pathname === '/api/state') {
                writeJson(response, 200, await buildState());
                return;
            }

            if (
                request.method === 'POST' &&
                requestUrl.pathname === '/api/policy/device'
            ) {
                if (!mutationOriginIsLocal(request)) {
                    writeJson(response, 403, { error: 'Invalid mutation origin.' });
                    return;
                }

                let body: unknown;
                try {
                    body = await readJsonBody(request);
                } catch {
                    writeJson(response, 400, { error: 'Invalid JSON request body.' });
                    return;
                }

                const deviceId = body && typeof body === 'object'
                    ? (body as Record<string, unknown>).deviceId
                    : undefined;

                if (typeof deviceId !== 'string' || !deviceId.trim()) {
                    writeJson(response, 400, { error: 'Invalid device ID.' });
                    return;
                }

                try {
                    writeJson(response, 200, await setPolicyDeviceId(deviceId));
                } catch (error) {
                    writeJson(response, 400, {
                        error: error instanceof Error
                            ? error.message
                            : 'Invalid device ID.',
                    });
                }
                return;
            }

            if (
                request.method === 'POST' &&
                requestUrl.pathname === '/api/policy/folders'
            ) {
                if (!mutationOriginIsLocal(request)) {
                    writeJson(response, 403, { error: 'Invalid mutation origin.' });
                    return;
                }

                let body: unknown;
                try {
                    body = await readJsonBody(request);
                } catch {
                    writeJson(response, 400, { error: 'Invalid JSON request body.' });
                    return;
                }

                if (!body || typeof body !== 'object') {
                    writeJson(response, 400, { error: 'Invalid folder permission request.' });
                    return;
                }

                const pathValue = (body as Record<string, unknown>).path;
                const permissionValue = (body as Record<string, unknown>).permission;

                if (
                    typeof pathValue !== 'string' ||
                    !isAbsolutePolicyPath(pathValue) ||
                    typeof permissionValue !== 'string' ||
                    !isFolderPermission(permissionValue)
                ) {
                    writeJson(response, 400, { error: 'Invalid folder permission.' });
                    return;
                }

                const policy = await setFolderPermission(pathValue, permissionValue);
                writeJson(response, 200, {
                    policy,
                    folderPermissions: listFolderPermissions(policy),
                });
                return;
            }

            if (
                request.method === 'POST' &&
                requestUrl.pathname === '/api/policy/commands'
            ) {
                if (!mutationOriginIsLocal(request)) {
                    writeJson(response, 403, { error: 'Invalid mutation origin.' });
                    return;
                }

                let body: unknown;
                try {
                    body = await readJsonBody(request);
                } catch {
                    writeJson(response, 400, { error: 'Invalid JSON request body.' });
                    return;
                }

                if (!body || typeof body !== 'object') {
                    writeJson(response, 400, { error: 'Invalid command permission request.' });
                    return;
                }

                const commandPrefix = (body as Record<string, unknown>).commandPrefix;
                const permissionValue = (body as Record<string, unknown>).permission;

                if (
                    typeof commandPrefix !== 'string' ||
                    !commandPrefix.trim() ||
                    typeof permissionValue !== 'string' ||
                    !isCommandPermission(permissionValue)
                ) {
                    writeJson(response, 400, { error: 'Invalid command permission.' });
                    return;
                }

                try {
                    const policy = await setCommandPermission(
                        commandPrefix,
                        permissionValue,
                    );
                    writeJson(response, 200, {
                        policy,
                        commandPermissions: listCommandPermissions(policy),
                    });
                } catch (error) {
                    writeJson(response, 400, {
                        error: error instanceof Error
                            ? error.message
                            : 'Invalid command permission.',
                    });
                }
                return;
            }

            const policyMatch = requestUrl.pathname.match(
                /^\/api\/policy\/(tier|profile)\/([^/]+)$/,
            );

            if (request.method === 'POST' && policyMatch) {
                if (!mutationOriginIsLocal(request)) {
                    writeJson(response, 403, { error: 'Invalid mutation origin.' });
                    return;
                }

                const kind = policyMatch[1];
                const value = decodeURIComponent(policyMatch[2]);

                if (kind === 'tier') {
                    if (!isDesktopCommanderTier(value)) {
                        writeJson(response, 400, { error: 'Invalid policy tier.' });
                        return;
                    }
                    writeJson(response, 200, await setPolicyTier(value));
                    return;
                }

                if (!isPolicyProfile(value)) {
                    writeJson(response, 400, { error: 'Invalid policy profile.' });
                    return;
                }

                writeJson(response, 200, await setPolicyProfile(value));
                return;
            }

            const approvalMatch = requestUrl.pathname.match(
                /^\/api\/approvals\/([^/]+)\/(approve|deny)$/,
            );

            if (request.method === 'POST' && approvalMatch) {
                if (!mutationOriginIsLocal(request)) {
                    writeJson(response, 403, { error: 'Invalid mutation origin.' });
                    return;
                }

                const requestId = decodeURIComponent(approvalMatch[1]);
                const decision = approvalMatch[2] === 'approve'
                    ? 'approved'
                    : 'denied';

                const record = await setApprovalDecision(requestId, decision);
                if (!record) {
                    writeJson(response, 404, {
                        error: 'Approval request was not found, expired, or is not pending.',
                    });
                    return;
                }

                writeJson(response, 200, record);
                return;
            }

            writeJson(response, 404, { error: 'Not found.' });
        } catch (error) {
            if (!options.quiet) {
                console.error(
                    'Desktop Commander Control Center request failed:',
                    error instanceof Error ? error.message : String(error),
                );
            }
            writeJson(response, 500, { error: 'Control Center request failed.' });
        }
    });

    await new Promise<void>((resolve, reject) => {
        const onError = (error: Error) => {
            server.off('listening', onListening);
            reject(error);
        };
        const onListening = () => {
            server.off('error', onError);
            resolve();
        };

        server.once('error', onError);
        server.once('listening', onListening);
        server.listen(requestedPort, host);
    });

    const address = server.address();
    if (!address || typeof address === 'string') {
        await new Promise<void>((resolve) => server.close(() => resolve()));
        throw new Error('Control Center failed to resolve its local listening address.');
    }

    const port = (address as AddressInfo).port;
    const urlHost = host === '::1' ? '[::1]' : host;
    const url = `http://${urlHost}:${port}/`;

    if (!options.quiet) {
        console.error(`Desktop Commander Control Center: ${url}`);
        console.error('Control Center is bound to loopback only.');
    }

    return {
        server,
        host,
        port,
        token,
        url,
        close: () => new Promise<void>((resolve, reject) => {
            server.close((error) => {
                if (error) {
                    reject(error);
                    return;
                }
                resolve();
            });
        }),
    };
}
