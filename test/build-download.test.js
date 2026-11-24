'use strict';
/**
 * downloadUrl against a local HTTP server: success, non-200 responses (no stub
 * file left behind, existing file untouched), redirects, and a connection that
 * drops mid-body (partial file removed).
 */

const { test, describe, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');

const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'micropage-cli-test-'));
process.env.HOME = tmpHome;
process.env.USERPROFILE = tmpHome;

const { downloadUrl } = require('../src/commands/builds');

const BODY = Buffer.alloc(64 * 1024, 'z');
let server;
let base;

before(async () => {
  server = http.createServer((req, res) => {
    if (req.url === '/ok') {
      res.writeHead(200, { 'Content-Length': BODY.length });
      res.end(BODY);
    } else if (req.url === '/forbidden') {
      res.writeHead(403, { 'Content-Type': 'application/xml' });
      res.end('<Error><Code>AccessDenied</Code></Error>');
    } else if (req.url === '/redirect') {
      res.writeHead(307, { Location: '/ok' });
      res.end();
    } else if (req.url === '/loop') {
      res.writeHead(302, { Location: '/loop' });
      res.end();
    } else if (req.url === '/truncated') {
      res.writeHead(200, { 'Content-Length': BODY.length * 2 });
      res.write(BODY, () => setTimeout(() => res.socket.destroy(), 20));
    } else {
      res.writeHead(404);
      res.end();
    }
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${server.address().port}`;
});

after(() => {
  server.close();
  fs.rmSync(tmpHome, { recursive: true, force: true });
});

function destPath(name) {
  return path.join(tmpHome, name);
}

describe('downloadUrl', () => {
  test('writes the full body on 200', async () => {
    const dest = destPath('ok.zip');
    await downloadUrl(`${base}/ok`, dest);
    assert.deepEqual(fs.readFileSync(dest), BODY);
  });

  test('rejects on 403 and leaves no file', async () => {
    const dest = destPath('forbidden.zip');
    await assert.rejects(downloadUrl(`${base}/forbidden`, dest), { message: 'Download failed: HTTP 403' });
    assert.equal(fs.existsSync(dest), false);
  });

  test('does not clobber an existing file on a non-200', async () => {
    const dest = destPath('existing.zip');
    fs.writeFileSync(dest, 'previous');
    await assert.rejects(downloadUrl(`${base}/forbidden`, dest), /HTTP 403/);
    assert.equal(fs.readFileSync(dest, 'utf8'), 'previous');
  });

  test('follows redirects', async () => {
    const dest = destPath('redirect.zip');
    await downloadUrl(`${base}/redirect`, dest);
    assert.deepEqual(fs.readFileSync(dest), BODY);
  });

  test('gives up on a redirect loop', async () => {
    const dest = destPath('loop.zip');
    await assert.rejects(downloadUrl(`${base}/loop`, dest), /too many redirects/);
    assert.equal(fs.existsSync(dest), false);
  });

  test('removes the partial file when the connection drops mid-body', async () => {
    const dest = destPath('truncated.zip');
    await assert.rejects(downloadUrl(`${base}/truncated`, dest), /Download failed/);
    assert.equal(fs.existsSync(dest), false);
  });

  test('rejects on connection refused without creating a file', async () => {
    const dest = destPath('refused.zip');
    const probe = http.createServer();
    await new Promise((r) => probe.listen(0, '127.0.0.1', r));
    const port = probe.address().port;
    await new Promise((r) => probe.close(r));
    await assert.rejects(downloadUrl(`http://127.0.0.1:${port}/x`, dest), /Download failed/);
    assert.equal(fs.existsSync(dest), false);
  });
});
