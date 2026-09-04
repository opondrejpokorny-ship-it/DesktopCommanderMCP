import assert from 'node:assert';
import {
  recordOperationalLesson,
} from '../../dist/workflow/project-workflow.js';

const [projectRoot, stateRoot, countRaw, lessonCode] = process.argv.slice(2);
const count = Number.parseInt(countRaw, 10);
assert.ok(projectRoot);
assert.ok(stateRoot);
assert.ok(Number.isInteger(count) && count > 0);
assert.ok(lessonCode);
process.env.DESKTOP_COMMANDER_WORKFLOW_STATE_DIR = stateRoot;

for (let index = 0; index < count; index += 1) {
  const recorded = await recordOperationalLesson({ projectRoot, lessonCode });
  assert.strictEqual(recorded, true);
}
