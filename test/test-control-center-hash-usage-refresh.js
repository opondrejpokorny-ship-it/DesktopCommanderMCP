import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { startControlCenter } from '../dist/control-center/server.js';

const running = await startControlCenter({
  host: '127.0.0.1',
  port: 0,
  token: 'hash-navigation-test-token',
  quiet: true,
});

const response = await fetch(running.url);
const html = await response.text();
await running.close();

async function render(hash) {
  const dom = new JSDOM(html, {
    url: `${running.url}${hash}`,
    runScripts: 'dangerously',
    beforeParse(window) {
      window.Headers = Headers;
      window.fetch = async (input) => {
        const url = new URL(String(input), running.url);
        const body = url.pathname === '/api/state'
          ? { entitlement: { tier: 'free' } }
          : { totalBytes: 0, returnedBytes: 0, writtenBytes: 0, periodStartedAt: null };
        return { ok: true, status: 200, json: async () => body };
      };
    },
  });  await new Promise((resolve) => setTimeout(resolve, 20));
  return dom;
}

let dom = await render('#usage');
let usageView = dom.window.document.querySelector('[data-dc-view="usage"]');
let memoryView = dom.window.document.querySelector('[data-dc-view="memory"]');
assert.equal(usageView.hidden, false, '#usage must open Usage on initial load');
assert.equal(memoryView.hidden, true, '#usage must hide the default Memory view');

const memoryButton = dom.window.document.querySelector('[data-dc-target="memory"]');
memoryButton.click();
await new Promise((resolve) => setTimeout(resolve, 0));
assert.equal(dom.window.location.hash, '#memory', 'Navigation clicks must update the URL hash');
assert.equal(memoryView.hidden, false, 'Clicking Memory must activate Memory');
assert.equal(usageView.hidden, true, 'Clicking Memory must hide Usage');

const refreshedHash = dom.window.location.hash;
dom.window.close();
dom = await render(refreshedHash);
usageView = dom.window.document.querySelector('[data-dc-view="usage"]');
memoryView = dom.window.document.querySelector('[data-dc-view="memory"]');
assert.equal(memoryView.hidden, false, 'Refresh must preserve the selected Memory view');
assert.equal(usageView.hidden, true, 'Refresh must not fall back to Usage');

dom.window.close();dom = await render('#not-a-real-view');
usageView = dom.window.document.querySelector('[data-dc-view="usage"]');
memoryView = dom.window.document.querySelector('[data-dc-view="memory"]');
assert.equal(memoryView.hidden, false, 'Invalid hash must fall back to the first available view');
assert.equal(usageView.hidden, true, 'Invalid hash must not reveal an unrelated view');
assert.equal(dom.window.location.hash, '#memory', 'Invalid hash must be normalized to the fallback view');

dom.window.close();
console.log('✅ Control Center hash navigation persistence passed');