import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(import.meta.url);
const { downloadFile } = require(path.join(root, 'scripts', 'installer', 'download-file.cjs'));

const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'dc-installer-download-'));
const destination = path.join(tempRoot, 'download.bin');
const body = Buffer.from('redirected-payload\n', 'utf8');

let server;
try {
  server = http.createServer((request, response) => {
    if (request.url === '/start') {
      response.writeHead(302, { Location: '/payload' });
      response.end();
      return;
    }
    if (request.url === '/payload') {
      response.writeHead(200, { 'Content-Type': 'application/octet-stream' });
      response.end(body);
      return;
    }
    response.writeHead(404);
    response.end();
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  assert.ok(address && typeof address !== 'string');

  await downloadFile(
    `http://127.0.0.1:${address.port}/start`,
    destination,
    { redirects: 3 },
  );
  assert.deepEqual(await fs.readFile(destination), body);
  console.log('✅ Windows Free installer downloader follows redirects atomically');
} finally {
  if (server) await new Promise((resolve) => server.close(resolve));
  await fs.rm(tempRoot, { recursive: true, force: true }).catch(() => undefined);
}
