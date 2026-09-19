const fs = require('node:fs/promises');
const fsSync = require('node:fs');
const http = require('node:http');
const https = require('node:https');
const path = require('node:path');

function clientFor(url) {
  const protocol = new URL(url).protocol;
  if (protocol === 'https:') return https;
  if (protocol === 'http:') return http;
  throw new Error('Unsupported download protocol: ' + protocol);
}

async function fetchToTemp(url, tempPath, redirects) {
  await new Promise((resolve, reject) => {
    const request = clientFor(url).get(
      url,
      { headers: { 'User-Agent': 'DesktopCommanderInstallerBuilder/1' } },
      (response) => {
        if (response.statusCode >= 300 && response.statusCode < 400 && response.headers.location) {
          response.resume();
          if (redirects <= 0) {
            reject(new Error('Download redirect limit exceeded'));
            return;
          }
          fetchToTemp(
            new URL(response.headers.location, url).toString(),
            tempPath,
            redirects - 1,
          ).then(resolve, reject);
          return;
        }
        if (response.statusCode !== 200) {
          response.resume();
          reject(new Error('Download failed with HTTP ' + response.statusCode));
          return;
        }
        const output = fsSync.createWriteStream(tempPath, { flags: 'wx' });
        response.pipe(output);
        output.on('finish', () => output.close(resolve));
        output.on('error', reject);
      },
    );
    request.on('error', reject);
  });
}

async function downloadFile(url, destination, { redirects = 5 } = {}) {
  await fs.mkdir(path.dirname(destination), { recursive: true });
  const tempPath = destination + '.download-' + process.pid;
  await fs.rm(tempPath, { force: true });
  try {
    await fetchToTemp(url, tempPath, redirects);
    await fs.rename(tempPath, destination);
  } catch (error) {
    await fs.rm(tempPath, { force: true }).catch(() => undefined);
    throw error;
  }
}

module.exports = { downloadFile };
