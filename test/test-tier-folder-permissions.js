/**
 * RED -> GREEN tests for managed folder permissions.
 */

import assert from 'node:assert';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  listFolderPermissions,
  loadPolicyRuntimeConfig,
  preflightToolRequest,
  setFolderPermission,
} from '../dist/policy/policy-runtime.js';

const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'dc-folder-policy-'));
const policyFile = path.join(tempDir, 'policy.json');
const broad = path.join(tempDir, 'projects');
const specific = path.join(broad, 'production');
const sibling = path.join(broad, 'sandbox');

try {
  await fs.writeFile(policyFile, JSON.stringify({
    version: 1,
    tier: 'pro',
    profile: 'full_access',
    rules: [],
  }));

  await setFolderPermission(broad, 'read_only', policyFile);

  assert.strictEqual(
    (await preflightToolRequest(
      'write_file',
      { path: path.join(sibling, 'app.ts'), content: 'change' },
      policyFile
    )).decision,
    'deny',
    'Read-only folder should deny writes'
  );

  await setFolderPermission(specific, 'read_write', policyFile);

  assert.strictEqual(
    (await preflightToolRequest(
      'write_file',
      { path: path.join(specific, 'app.ts'), content: 'change' },
      policyFile
    )).decision,
    'allow',
    'More specific read/write folder should override broader read-only folder'
  );

  // Edit the broad rule afterwards. Specificity, not edit order, must decide.
  await setFolderPermission(broad, 'blocked', policyFile);

  assert.strictEqual(
    (await preflightToolRequest(
      'write_file',
      { path: path.join(specific, 'app.ts'), content: 'change' },
      policyFile
    )).decision,
    'allow',
    'Specific folder rule must win even when broad rule was edited later'
  );

  assert.strictEqual(
    (await preflightToolRequest(
      'read_file',
      { path: path.join(sibling, 'app.ts') },
      policyFile
    )).decision,
    'deny',
    'Blocked broad folder should deny reads outside the specific exception'
  );

  await setFolderPermission(specific, 'inherit', policyFile);

  assert.strictEqual(
    (await preflightToolRequest(
      'write_file',
      { path: path.join(specific, 'app.ts'), content: 'change' },
      policyFile
    )).decision,
    'deny',
    'Removing the specific rule should inherit the broad blocked rule'
  );

  await setFolderPermission(broad, 'blocked', policyFile);
  await setFolderPermission(specific, 'read_write', policyFile);
  await fs.mkdir(specific, { recursive: true });
  await fs.mkdir(sibling, { recursive: true });
  await fs.writeFile(path.join(sibling, 'app.ts'), 'sibling');

  const link = path.join(specific, 'link-to-sibling');
  try {
    await fs.symlink(
      sibling,
      link,
      process.platform === 'win32' ? 'junction' : 'dir'
    );

    assert.strictEqual(
      (await preflightToolRequest(
        'read_file',
        { path: path.join(link, 'app.ts') },
        policyFile
      )).decision,
      'deny',
      'A symlink/junction must not escape a more-specific allowed folder into a blocked sibling'
    );
    assert.strictEqual(
      (await preflightToolRequest(
        'write_file',
        { path: path.join(link, 'new.ts'), content: 'change' },
        policyFile
      )).decision,
      'deny',
      'A symlink/junction write must be evaluated against its canonical target'
    );
  } finally {
    await fs.rm(link, { recursive: true, force: true }).catch(() => {});
  }

  await setFolderPermission(specific, 'inherit', policyFile);

  const config = await loadPolicyRuntimeConfig(policyFile);
  const folders = listFolderPermissions(config);
  assert.deepStrictEqual(folders, [{ path: broad, permission: 'blocked' }]);

  console.log('✅ Managed folder permission tests passed');
} finally {
  await fs.rm(tempDir, { recursive: true, force: true });
}
