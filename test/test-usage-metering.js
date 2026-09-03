/**
 * RED -> GREEN tests for privacy-safe usage metering.
 */

import assert from 'node:assert';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  calculateReturnedBytes,
  calculateWritePayloadBytes,
  loadUsageMeter,
  recordUsage,
} from '../dist/utils/usageMetering.js';

const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'dc-usage-meter-test-'));
const usageFile = path.join(tempDir, 'usage.json');

try {
  const result = {
    content: [{ type: 'text', text: 'hello €' }],
    isError: false,
  };
  assert.strictEqual(
    calculateReturnedBytes(result),
    Buffer.byteLength(JSON.stringify(result), 'utf8'),
  );
  assert.strictEqual(calculateWritePayloadBytes('read_file', { path: '/tmp/a' }), 0);
  assert.strictEqual(
    calculateWritePayloadBytes('write_file', { content: 'hello €' }),
    Buffer.byteLength('hello €', 'utf8'),
  );
  assert.strictEqual(
    calculateWritePayloadBytes('edit_block', { new_string: 'replacement €' }),
    Buffer.byteLength('replacement €', 'utf8'),
  );
  const pdfContent = [{ type: 'insert', pageIndex: 0, markdown: '# Hello' }];
  assert.strictEqual(
    calculateWritePayloadBytes('write_pdf', { content: pdfContent }),
    Buffer.byteLength(JSON.stringify(pdfContent), 'utf8'),
  );

  const first = await recordUsage({ returnedBytes: 120, writtenBytes: 30 }, usageFile);
  assert.strictEqual(first.returnedBytes, 120);
  assert.strictEqual(first.writtenBytes, 30);
  assert.ok(!Number.isNaN(Date.parse(first.periodStartedAt)));

  const second = await recordUsage({ returnedBytes: 7, writtenBytes: 5 }, usageFile);
  assert.deepStrictEqual(second, {
    returnedBytes: 127,
    writtenBytes: 35,
    periodStartedAt: first.periodStartedAt,
  });
  const loaded = await loadUsageMeter(usageFile);
  assert.deepStrictEqual(loaded, second);

  const raw = await fs.readFile(usageFile, 'utf8');
  assert.ok(!raw.includes('hello €'));
  assert.ok(!raw.includes('replacement €'));
  assert.deepStrictEqual(Object.keys(JSON.parse(raw)).sort(), [
    'periodStartedAt',
    'returnedBytes',
    'writtenBytes',
  ]);

  await fs.writeFile(usageFile, '{ definitely invalid json');
  await assert.rejects(() => loadUsageMeter(usageFile), /usage/i);

  console.log('✅ Usage metering tests passed');
} finally {
  await fs.rm(tempDir, { recursive: true, force: true });
}
