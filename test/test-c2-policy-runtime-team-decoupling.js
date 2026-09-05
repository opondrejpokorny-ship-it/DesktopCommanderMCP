/**
 * C2 RED -> GREEN: Pro runtime must not depend on Team audit storage.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { preflightToolRequest } from '../dist/policy/policy-runtime.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const source = await fs.readFile(path.join(root, 'src/policy/policy-runtime.ts'), 'utf8');
assert.doesNotMatch(
  source,
  /from ['"].*audit-store/,
  'Pro policy runtime must not import Team audit storage',
);

const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'dc-c2-policy-runtime-'));
const policyFile = path.join(tempDir, 'policy.json');
const approvalFile = path.join(tempDir, 'approvals.json');
const auditFile = path.join(tempDir, 'team-audit.jsonl');
const ordinaryFile = path.join(tempDir, 'project.txt');
const previousApproval = process.env.DESKTOP_COMMANDER_APPROVAL_FILE;
process.env.DESKTOP_COMMANDER_APPROVAL_FILE = approvalFile;
try {
  await fs.writeFile(policyFile, JSON.stringify({
    version: 1,
    tier: 'pro',
    profile: 'full_access',
    rules: [],
  }));

  for (const protectedPath of [policyFile, approvalFile]) {
    assert.strictEqual(
      (await preflightToolRequest(
        'write_file',
        { path: protectedPath, content: 'tamper' },
        policyFile,
      )).decision,
      'deny',
      'Pro policy and approval files remain protected without Team storage',
    );
  }

  assert.strictEqual(
    (await preflightToolRequest(
      'write_file',
      { path: auditFile, content: 'ordinary without Team composition' },
      policyFile,
    )).decision,
    'allow',
    'Pro runtime must not implicitly know the Team audit resource',
  );
  const auditAlias = path.join(tempDir, 'child', '..', 'team-audit.jsonl');
  assert.strictEqual(
    (await preflightToolRequest(
      'write_file',
      { path: auditAlias, content: 'tamper' },
      policyFile,
      { protectedControlPlanePaths: [auditFile] },
    )).decision,
    'deny',
    'Commercial composition must be able to inject protected Team resources',
  );

  assert.strictEqual(
    (await preflightToolRequest(
      'write_file',
      { path: ordinaryFile, content: 'normal project change' },
      policyFile,
      { protectedControlPlanePaths: [auditFile] },
    )).decision,
    'allow',
    'Injected Team resources must not broaden protection to ordinary files',
  );

  console.log('✅ C2 policy runtime / Team storage decoupling tests passed');
} finally {
  if (previousApproval === undefined) delete process.env.DESKTOP_COMMANDER_APPROVAL_FILE;
  else process.env.DESKTOP_COMMANDER_APPROVAL_FILE = previousApproval;
  await fs.rm(tempDir, { recursive: true, force: true });
}

const boundary = JSON.parse(await fs.readFile(
  path.join(root, 'docs/tier-prototype/open-core-boundaries.json'),
  'utf8',
));
for (const file of [
  'src/policy/policy-runtime.ts',
  'src/policy/policy-gate.ts',
]) {
  assert.strictEqual(
    boundary.ownershipRules.find((rule) => rule.kind === 'file' && rule.path === file)?.owner,
    'pro',
    `${file} must be classified as Pro after Team storage decoupling`,
  );
}
