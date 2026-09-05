import {
    isDesktopCommanderTier,
    setPolicyTier,
} from '../policy/policy-runtime.js';
import type {
    ControlCenterExtensionV1,
    ControlCenterJsonResponseV1,
    ControlCenterRequestContextV1,
} from './contract.js';

async function handleTier(
    context: ControlCenterRequestContextV1,
): Promise<ControlCenterJsonResponseV1> {
    const tier = context.params.tier;
    if (!isDesktopCommanderTier(tier)) {
        return { status: 400, body: { error: 'Invalid policy tier.' } };
    }
    const policy = await setPolicyTier(tier);
    return { status: 200, body: { tier: policy.tier } };
}

const DEMO_HTML = `
<section id="dc-demo-root">
  <h2>Prototype tier</h2>
  <p id="dc-demo-status">Demo-only tier selector</p>
  <label>Tier <select id="dc-demo-tier">
    <option value="free">Free</option>
    <option value="pro">Pro</option>
    <option value="team">Team</option>
  </select></label>
  <button id="dc-demo-save-tier">Apply demo tier</button>
</section>`;

const DEMO_SCRIPT = `
(() => {
  const api = window.dcControlCenter.api;
  const status = document.getElementById('dc-demo-status');
  const tier = document.getElementById('dc-demo-tier');
  document.getElementById('dc-demo-save-tier').addEventListener('click', async () => {
    try {
      status.textContent = 'Applying demo tier...';
      const result = await api('/api/demo/tier/' + encodeURIComponent(tier.value), {
        method: 'POST'
      });
      status.textContent = 'Prototype tier: ' + result.tier;
    } catch (error) {
      status.textContent = error instanceof Error ? error.message : String(error);
    }
  });
})();`;
export function createDemoControlCenterExtension(): ControlCenterExtensionV1 {
    return {
        id: 'demo',
        apiPrefixes: ['/api/demo'],
        routes: [{
            method: 'POST',
            apiPrefix: '/api/demo',
            path: '/tier/:tier',
            handle: handleTier,
        }],
        ui: {
            viewId: 'demo-tier',
            label: 'Prototype tier',
            html: DEMO_HTML,
            script: DEMO_SCRIPT,
        },
    };
}
