import { loadUsageMeter } from '../utils/usageMetering.js';
import type {
    ControlCenterExtensionV1,
    ControlCenterJsonResponseV1,
} from './contract.js';

const API_PREFIX = '/api/usage' as const;

async function handleUsageState(): Promise<ControlCenterJsonResponseV1> {
    const state = await loadUsageMeter();
    const totalBytes = state.returnedBytes + state.writtenBytes;
    if (!Number.isSafeInteger(totalBytes)) {
        throw new Error('Usage meter total overflow');
    }
    return {
        status: 200,
        body: {
            totalBytes,
            returnedBytes: state.returnedBytes,
            writtenBytes: state.writtenBytes,
            periodStartedAt: state.periodStartedAt,
        },
    };
}

export function createUsageControlCenterExtension(): ControlCenterExtensionV1 {
    return {
        id: 'usage',
        apiPrefixes: [API_PREFIX],
        routes: [{
            method: 'GET',
            apiPrefix: API_PREFIX,
            path: '/state',
            handle: handleUsageState,
        }],
        ui: {
            viewId: 'usage',
            label: 'Usage',
            html: USAGE_UI_HTML,
            script: USAGE_UI_SCRIPT,
        },
    };
}

const USAGE_UI_HTML = `
<section id="usage-root">
  <h2>Usage</h2>
  <p>Application payload only. This does not include local disk I/O or protocol/WebSocket overhead.</p>
  <dl>
    <dt>Total data usage</dt><dd data-usage-metric="total">—</dd>
    <dt>Returned to AI</dt><dd data-usage-metric="returned">—</dd>
    <dt>Write/edit payload to device</dt><dd data-usage-metric="written">—</dd>
    <dt>Period started</dt><dd data-usage-metric="period">—</dd>
  </dl>
  <p id="usage-status">Loading usage…</p>
</section>`;

const USAGE_UI_SCRIPT = `(() => {
  const api = window.dcControlCenter.api;
  const status = document.getElementById('usage-status');
  const metric = (name) => document.querySelector('[data-usage-metric="' + name + '"]');
  function formatBytes(bytes) {
    if (!Number.isSafeInteger(bytes) || bytes < 0) return '—';
    const units = ['B', 'KB', 'MB', 'GB', 'TB'];
    let value = bytes;
    let unit = 0;
    while (value >= 1024 && unit < units.length - 1) {
      value /= 1024;
      unit += 1;
    }
    const digits = unit === 0 ? 0 : value >= 10 ? 1 : 2;
    return value.toFixed(digits) + ' ' + units[unit];
  }
  async function refresh() {
    status.textContent = 'Loading usage…';
    try {
      const state = await api('/api/usage/state');
      metric('total').textContent = formatBytes(state.totalBytes);
      metric('returned').textContent = formatBytes(state.returnedBytes);
      metric('written').textContent = formatBytes(state.writtenBytes);
      metric('period').textContent = state.periodStartedAt
        ? new Date(state.periodStartedAt).toLocaleString()
        : 'Not started';
      status.textContent = 'Usage meter ready.';
    } catch (error) {
      status.textContent = error instanceof Error ? error.message : 'Usage is unavailable.';
    }
  }
  const usageButton = document.querySelector('[data-dc-target="usage"]');
  if (usageButton) usageButton.addEventListener('click', refresh);
  refresh();
})();`;
