/** RED: M2 SQLite persists structural correlation only, not arbitrary identifier prose. */
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

let DatabaseSync;
try { ({ DatabaseSync } = await import('node:sqlite')); }
catch { console.log('SKIP M2 privacy structure: node:sqlite unavailable'); process.exit(0); }

const workflow = await import('../dist/workflow/project-workflow.js');
const storage = await import('../dist/workflow/workflow-storage.js');
const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'dc-memory-m2-privacy-'));
const projectRoot = path.join(tempDir, 'repo');
const stateRoot = path.join(tempDir, 'state');
const previousStateRoot = process.env.DESKTOP_COMMANDER_WORKFLOW_STATE_DIR;
process.env.DESKTOP_COMMANDER_WORKFLOW_STATE_DIR = stateRoot;
try {
  await fs.mkdir(path.join(projectRoot, '.desktop-commander'), { recursive: true });
  await fs.writeFile(path.join(projectRoot, '.desktop-commander', 'project-workflow.json'), JSON.stringify({
    version: 1,
    id: 'memory-m2-privacy',
    name: 'Operational Memory M2 privacy',
    stages: [{ id: 'inspect', label: 'Inspect', required: true }],
  }, null, 2));
  execFileSync('git', ['init', projectRoot]);
  execFileSync('git', ['-C', projectRoot, 'config', 'user.email', 'privacy@example.invalid']);
  execFileSync('git', ['-C', projectRoot, 'config', 'user.name', 'Memory Privacy Test']);
  await fs.writeFile(path.join(projectRoot, 'README.md'), '# privacy\n');
  execFileSync('git', ['-C', projectRoot, 'add', '.']);
  execFileSync('git', ['-C', projectRoot, 'commit', '-m', 'baseline']);

  const started = await workflow.startProjectWorkflow({ projectRoot, goal: 'Keep index structural only' });
  assert.equal(await workflow.recordOperationalToolFailure({
    tool: 'read_file',
    args: { path: path.join(projectRoot, 'missing.txt') },
    result: { content: [{ type: 'text', text: 'Error: ENOENT missing resource' }], isError: true },
  }), true);
  await workflow.getProjectWorkflowStatus({ projectRoot });
  const memoryPath = workflow.resolveWorkflowMemoryPath(projectRoot);
  const [seedLine] = (await fs.readFile(memoryPath, 'utf8')).trim().split(/\r?\n/);
  const seed = JSON.parse(seedLine);
  await fs.appendFile(memoryPath, JSON.stringify({
    ...seed,
    id: 'PRIVATE_EVENT_ID_PROSE_MARKER',
    occurredAt: new Date(Date.now() + 1000).toISOString(),
  }) + '\n');
  await fs.appendFile(memoryPath, JSON.stringify({
    ...seed,
    id: 'synthetic-id',
    workflowId: 'PRIVATE_WORKFLOW_PROSE_MARKER',
    occurredAt: new Date(Date.now() + 2000).toISOString(),
  }) + '\n');
  await workflow.getProjectWorkflowStatus({ projectRoot });

  const db = new DatabaseSync(storage.resolveWorkflowMemoryIndexPath(projectRoot), { readOnly: true });
  try {
    const eventColumns = db.prepare('PRAGMA table_info(events)').all().map((row) => row.name);
    assert.ok(!eventColumns.includes('event_id'), 'derived events table must not persist arbitrary event-id prose');
    const leakedWorkflow = db.prepare('SELECT COUNT(*) AS count FROM events WHERE workflow_id = ?')
      .get('PRIVATE_WORKFLOW_PROSE_MARKER');
    assert.equal(Number(leakedWorkflow.count), 0, 'non-UUID workflow prose must not be indexed');
    const projectColumns = db.prepare('PRAGMA table_info(project_groups)').all().map((row) => row.name);
    for (const forbidden of ['summary', 'lesson', 'raw_args', 'command', 'content', 'output', 'path']) {
      assert.ok(!projectColumns.includes(forbidden), 'project_groups must remain structural: ' + forbidden);
    }
    const projectRows = db.prepare('SELECT fingerprint, source_tool, family, stage_id FROM project_groups').all();
    assert.ok(projectRows.length > 0, 'project_groups should contain sanitized aggregate metadata');
    assert.equal(JSON.stringify(projectRows).includes('PRIVATE_EVENT_ID_PROSE_MARKER'), false);
  } finally {
    db.close();
  }
  console.log('PASS M2 SQLite persists structural identifiers only');
} finally {
  if (previousStateRoot === undefined) delete process.env.DESKTOP_COMMANDER_WORKFLOW_STATE_DIR;
  else process.env.DESKTOP_COMMANDER_WORKFLOW_STATE_DIR = previousStateRoot;
  await fs.rm(tempDir, { recursive: true, force: true });
}
