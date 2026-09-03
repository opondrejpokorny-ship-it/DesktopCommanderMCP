/**
 * RED -> GREEN tests for managed command permissions.
 */

import assert from 'node:assert';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  listCommandPermissions,
  preflightToolRequest,
  setCommandPermission,
} from '../dist/policy/policy-runtime.js';

const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'dc-command-policy-'));
const policyFile = path.join(tempDir, 'policy.json');

try {
  await fs.writeFile(policyFile, JSON.stringify({
    version: 1,
    tier: 'pro',
    profile: 'full_access',
    rules: [],
  }));

  await setCommandPermission('git push', 'approval_required', policyFile);

  assert.strictEqual(
    (await preflightToolRequest(
      'start_process',
      { command: 'git push origin main', timeout_ms: 5000 },
      policyFile
    )).decision,
    'require_approval',
    'git push prefix should require approval'
  );

  assert.strictEqual(
    (await preflightToolRequest(
      'start_process',
      { command: 'git status', timeout_ms: 5000 },
      policyFile
    )).decision,
    'allow',
    'Unrelated git command should remain allowed'
  );

  for (const command of [
    'echo ready && git push origin main',
    '/usr/bin/git push origin main',
    'GIT_TRACE=1 git push origin main',
    'git.exe push origin main',
    'echo "$(git push origin main)"',
  ]) {
    assert.strictEqual(
      (await preflightToolRequest(
        'start_process',
        { command, timeout_ms: 5000 },
        policyFile
      )).decision,
      'require_approval',
      `Token-aware matcher should catch: ${command}`
    );
  }

  assert.strictEqual(
    (await preflightToolRequest(
      'start_process',
      { command: 'cd /tmp && git push origin main', timeout_ms: 5000 },
      policyFile
    )).decision,
    'require_approval',
    'Managed command should be detected inside a chained shell command'
  );

  assert.strictEqual(
    (await preflightToolRequest(
      'start_process',
      { command: 'echo "$(git push origin main)"', timeout_ms: 5000 },
      policyFile
    )).decision,
    'require_approval',
    'Managed command should be detected inside command substitution'
  );

  assert.strictEqual(
    (await preflightToolRequest(
      'start_process',
      { command: 'git push-notes', timeout_ms: 5000 },
      policyFile
    )).decision,
    'allow',
    'Managed command prefixes must stop at token boundaries'
  );

  await setCommandPermission('npm publish', 'blocked', policyFile);

  assert.strictEqual(
    (await preflightToolRequest(
      'start_process',
      { command: 'npm publish --access public', timeout_ms: 5000 },
      policyFile
    )).decision,
    'deny',
    'Blocked command prefix should deny execution'
  );

  assert.strictEqual(
    (await preflightToolRequest(
      'start_process',
      { command: 'npm publisher-info', timeout_ms: 5000 },
      policyFile
    )).decision,
    'allow',
    'Command prefix must stop at a shell token boundary'
  );

  await setCommandPermission('git push', 'inherit', policyFile);
  const commands = listCommandPermissions(
    JSON.parse(await fs.readFile(policyFile, 'utf8'))
  );
  assert.deepStrictEqual(commands, [
    { commandPrefix: 'npm publish', permission: 'blocked' }
  ]);

  console.log('✅ Managed command permission tests passed');
} finally {
  await fs.rm(tempDir, { recursive: true, force: true });
}
