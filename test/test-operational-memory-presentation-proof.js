/** M8 presentation-proof contract for indexed Operational Memory scale/recovery/privacy. */
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const proofPath = path.join(repoRoot, 'test', 'benchmarks', 'operational-memory-indexed-scale-proof.js');
const output = execFileSync(process.execPath, [proofPath, '--datasets=250,1000'], {
  cwd: repoRoot,
  encoding: 'utf8',
  env: process.env,
});
const records = output
  .split(/\r?\n/)
  .filter((line) => line.startsWith('{'))
  .map((line) => JSON.parse(line));
const meta = records.find((record) => record.type === 'meta');
const datasets = records.filter((record) => record.type === 'dataset');
assert.equal(meta?.proofVersion, 1);
assert.deepEqual(datasets.map((record) => record.eventCount), [250, 1000]);
for (const dataset of datasets) {
  assert.equal(dataset.indexedEventCount, dataset.eventCount + 1);
  assert.equal(dataset.incrementalCountVerified, true);
  assert.equal(dataset.steadyStateIndexUnchanged, true);
  assert.equal(dataset.rebuildEquivalent, true);
  assert.equal(dataset.privacyMarkersAbsent, true);
  assert.ok(dataset.indexBytes > 0);
  assert.ok(dataset.journalBytes > 0);
  assert.ok(dataset.returnedLessons <= 8);
  assert.ok(dataset.modelFacingEvents <= 1000);
  assert.ok(Number.isFinite(dataset.initialRebuildMs));
  assert.ok(Number.isFinite(dataset.steadyStateMs));
  assert.ok(Number.isFinite(dataset.rebuildAfterDeleteMs));
  assert.ok(Number.isFinite(dataset.incrementalAppendMs));
}
console.log('✅ Operational Memory M8 presentation proof contract passed');
