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

  const unrelatedGit = await preflightToolRequest(
    'start_process',
    { command: 'git status', timeout_ms: 5000 },
    policyFile
  );
  assert.strictEqual(
    unrelatedGit.decision,
    'allow',
    'Unmatched Full Access terminal commands should remain allowed'
  );
  assert.strictEqual(unrelatedGit.matchedRuleId, undefined);

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

  const tokenBoundary = await preflightToolRequest(
    'start_process',
    { command: 'git push-notes', timeout_ms: 5000 },
    policyFile
  );
  assert.strictEqual(
    tokenBoundary.decision,
    'allow',
    'Non-matching command prefixes should remain allowed under Full Access'
  );
  assert.strictEqual(
    tokenBoundary.matchedRuleId,
    undefined,
    'git push must not accidentally match git push-notes'
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

  for (const wrapped of [
    'cmd.exe /d /s /c "npm publish --access public"',
    'powershell.exe -NoProfile -Command "npm publish --access public"',
    'pwsh -NoProfile -Command "npm publish --access public"',
    'bash -lc "npm publish --access public"',
    'sh -c "npm publish --access public"',
  ]) {
    assert.strictEqual(
      (await preflightToolRequest(
        'start_process',
        { command: wrapped, timeout_ms: 5000 },
        policyFile
      )).decision,
      'deny',
      `Common shell wrapper must not bypass a managed command restriction: ${wrapped}`
    );
  }

  const npmBoundary = await preflightToolRequest(
    'start_process',
    { command: 'npm publisher-info', timeout_ms: 5000 },
    policyFile
  );
  assert.strictEqual(
    npmBoundary.decision,
    'allow',
    'Non-matching npm commands should remain allowed under Full Access'
  );
  assert.strictEqual(
    npmBoundary.matchedRuleId,
    undefined,
    'npm publish must not accidentally match npm publisher-info'
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
