import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const exists = async (relative) => fs.stat(path.join(root, relative)).then(() => true, () => false);

const forbiddenPaidSource = [
  'src/policy',
  'src/prototype',
  'src/control-center/pro-extension.ts',
  'src/control-center/team-extension.ts',
  'src/control-center/demo-extension.ts',
  'src/npm-scripts/access-control.ts',
];

for (const relative of forbiddenPaidSource) {
  assert.equal(
    await exists(relative),
    false,
    `Public Free source must physically lack active Commercial implementation: ${relative}`,
  );
}

const indexSource = await fs.readFile(path.join(root, 'src/index.ts'), 'utf8');
assert.doesNotMatch(indexSource, /prototype\//, 'Default public entrypoint must not import prototype composition');
assert.doesNotMatch(indexSource, /policy\//, 'Default public entrypoint must not import Commercial policy');

const controlCenterServer = await fs.readFile(path.join(root, 'src/control-center/server.ts'), 'utf8');
for (const forbidden of ['prototype/', 'pro-extension', 'team-extension', 'demo-extension']) {
  assert.ok(!controlCenterServer.includes(forbidden), `Free Control Center composition must not include ${forbidden}`);
}
assert.match(controlCenterServer, /memory-extension/, 'Free Control Center must keep Memory');
assert.match(controlCenterServer, /usage-extension/, 'Free Control Center must keep Usage');

console.log('✅ Public Free source physically lacks active Commercial implementation');
