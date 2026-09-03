/**
 * RED -> GREEN tests for Pro/Team control-plane hardening.
 */

import assert from 'node:assert';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  preflightToolRequest,
  setCommandPermission,
} from '../dist/policy/policy-runtime.js';

const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'dc-control-plane-'));
const policyFile = path.join(tempDir, 'policy.json');
const approvalFile = path.join(tempDir, 'approvals.json');
const auditFile = path.join(tempDir, 'audit.jsonl');
const ordinaryFile = path.join(tempDir, 'project', 'app.ts');

const previousEnv = {
  approval: process.env.DESKTOP_COMMANDER_APPROVAL_FILE,
  audit: process.env.DESKTOP_COMMANDER_AUDIT_FILE,
};

process.env.DESKTOP_COMMANDER_APPROVAL_FILE = approvalFile;
process.env.DESKTOP_COMMANDER_AUDIT_FILE = auditFile;

try {
  await fs.mkdir(path.dirname(ordinaryFile), { recursive: true });
  await fs.writeFile(policyFile, JSON.stringify({
    version: 1,
    tier: 'pro',
    profile: 'full_access',
    rules: [],
  }));

  assert.strictEqual(
    (await preflightToolRequest(
      'start_process',
      { command: 'echo hello', timeout_ms: 5000 },
      policyFile
    )).decision,
    'allow',
    'Pro Full Access should not require approval for terminal execution by default'
  );

  await setCommandPermission('git status', 'approval_required', policyFile);
  assert.strictEqual(
    (await preflightToolRequest(
      'start_process',
      { command: 'git status', timeout_ms: 5000 },
      policyFile
    )).decision,
    'require_approval',
    'An explicit command restriction must still apply under Full Access'
  );

  await setCommandPermission('git status', 'allow', policyFile);
  assert.strictEqual(
    (await preflightToolRequest(
      'start_process',
      { command: 'git status', timeout_ms: 5000 },
      policyFile
    )).decision,
    'allow',
    'A specific explicit command allow should override the terminal baseline'
  );

  for (const [tool, args] of [
    ['write_file', { path: approvalFile, content: 'tamper' }],
    ['edit_block', {
      file_path: policyFile,
      old_string: 'pro',
      new_string: 'free',
    }],
    ['delete_file', { path: auditFile }],
    ['move_file', {
      source: ordinaryFile,
      destination: policyFile,
    }],
  ]) {
    assert.strictEqual(
      (await preflightToolRequest(tool, args, policyFile)).decision,
      'deny',
      `Pro/Team must deny MCP mutation of control-plane files via ${tool}`
    );
  }

  assert.strictEqual(
    (await preflightToolRequest(
      'write_file',
      { path: ordinaryFile, content: 'normal project change' },
      policyFile
    )).decision,
    'allow',
    'Pro full_access may still edit ordinary files unless a folder rule restricts them'
  );

  await fs.writeFile(policyFile, JSON.stringify({
    version: 1,
    tier: 'free',
    rules: [],
  }));

  assert.strictEqual(
    (await preflightToolRequest(
      'write_file',
      { path: approvalFile, content: 'free behavior' },
      policyFile
    )).decision,
    'allow',
    'Free preserves the original unrestricted MCP behavior'
  );

  console.log('✅ Pro/Team control-plane hardening tests passed');
} finally {
  if (previousEnv.approval === undefined) {
    delete process.env.DESKTOP_COMMANDER_APPROVAL_FILE;
  } else {
    process.env.DESKTOP_COMMANDER_APPROVAL_FILE = previousEnv.approval;
  }
  if (previousEnv.audit === undefined) {
    delete process.env.DESKTOP_COMMANDER_AUDIT_FILE;
  } else {
    process.env.DESKTOP_COMMANDER_AUDIT_FILE = previousEnv.audit;
  }
  await fs.rm(tempDir, { recursive: true, force: true });
}