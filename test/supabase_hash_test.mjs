'use strict';
/**
 * Tests for the content-hash changes in cli/src/supabase.js.
 *
 * Covers:
 *   - hashFile: digest of known bytes equals expected SHA-256.
 *   - uploadAssetsWithToken (via fetch stubs): three upload-decision branches:
 *       (a) filename absent on server  → upload, no delete
 *       (b) filename present with matching hash → skip (no upload, no delete)
 *       (c) filename present with differing hash → delete then upload
 *       (d) filename present with NULL hash → delete then upload (backwards compat)
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// ---------------------------------------------------------------------------
// Resolve the module under test
// ---------------------------------------------------------------------------
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const supabaseSrc = path.join(__dirname, '..', 'src', 'supabase.js');

// We need to require() the CommonJS module.  supabase.js uses require() for
// config and auth at the top level, so mock those before importing.

import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);

// Stub modules that would fail without a real environment -----------------
const Module = require('module');
const originalLoad = Module._load.bind(Module);
const stubs = {
  './auth': {
    getSession: () => null,
    setSession: () => {},
    clearSession: () => {},
  },
  './config': {
    SUPABASE_URL: 'https://stub.supabase.co',
    SUPABASE_ANON_KEY: 'stub-anon-key',
    BUILD_COMPILER_URL: 'https://stub.build-compiler',
  },
};
Module._load = function (request, parent, isMain) {
  if (stubs[request]) return stubs[request];
  return originalLoad(request, parent, isMain);
};

const supabase = require(supabaseSrc);
const { uploadAssetsWithToken, hashFile } = supabase;

// Restore Module._load after requiring
Module._load = originalLoad;

// ---------------------------------------------------------------------------
// hashFile correctness — call the function directly with a fixture file
// ---------------------------------------------------------------------------

test('hashFile returns SHA-256 hex of the file contents', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mp_hash_'));
  const filePath = path.join(tmp, 'fixture.bin');
  const content = Buffer.from('hello micropage');
  fs.writeFileSync(filePath, content);

  const expected = crypto.createHash('sha256').update(content).digest('hex');
  const actual = hashFile(filePath);

  fs.rmSync(tmp, { recursive: true });

  assert.match(actual, /^[a-f0-9]{64}$/, 'result must be 64 lowercase hex chars');
  assert.equal(actual, expected, 'hashFile must match Node crypto digest of same bytes');
});

// ---------------------------------------------------------------------------
// uploadAssetsWithToken decision-logic tests
// ---------------------------------------------------------------------------
//
// We set up a temporary project dir with an `assets/` subfolder, stub
// global.fetch, and the parser's listAssetsFromDir, then invoke
// uploadAssetsWithToken and assert which fetch calls were made.

function makeTmpProject(files) {
  // files: { [filename]: Buffer }
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mp_test_'));
  const assetsDir = path.join(dir, 'assets');
  fs.mkdirSync(assetsDir);
  for (const [name, content] of Object.entries(files)) {
    fs.writeFileSync(path.join(assetsDir, name), content);
  }
  return dir;
}

function localHash(content) {
  return crypto.createHash('sha256').update(content).digest('hex');
}

function makeListResponse(files) {
  // files: [{filename, id, content_hash}]
  return {
    ok: true,
    json: async () => ({ files }),
  };
}

function makeUploadResponse() {
  return {
    ok: true,
    text: async () => JSON.stringify({ success: true, file: { id: 99 } }),
  };
}

function makeDeleteResponse() {
  return {
    ok: true,
    text: async () => JSON.stringify({ success: true }),
  };
}

// Stub parser module so we don't pull in the full parser
const parserStub = {
  listAssetsFromDir: (cwd) => {
    const assetsDir = path.join(cwd, 'assets');
    return fs.readdirSync(assetsDir);
  },
};

// Patch require inside supabase.js for ./parser — we do this via Module._load
// during the test runs. Since the module is already cached, we patch the
// cached module instead.
const parserModuleId = require.resolve(path.join(__dirname, '..', 'src', 'parser'));
// If parser doesn't exist yet (it might), provide a stub in cache.
try {
  require(parserModuleId);
} catch (_) {
  // parser not loadable — inject stub into cache
  require.cache[parserModuleId] = { id: parserModuleId, filename: parserModuleId, loaded: true, exports: parserStub };
}

// Replace listAssetsFromDir in the cached parser with our stub version that
// just reads the real temp dir.
const cachedParser = require.cache[parserModuleId];
if (cachedParser) {
  cachedParser.exports.listAssetsFromDir = parserStub.listAssetsFromDir;
}

// Also stub ./mime for uploadAssetWithToken
const mimePath = require.resolve(path.join(__dirname, '..', 'src', 'mime'));
try { require(mimePath); } catch (_) {}
if (!require.cache[mimePath]) {
  require.cache[mimePath] = { id: mimePath, filename: mimePath, loaded: true, exports: { fromFilename: () => 'application/octet-stream' } };
} else {
  require.cache[mimePath].exports.fromFilename = () => 'application/octet-stream';
}

// ---------------------------------------------------------------------------

test('uploadAssetsWithToken (a): uploads when filename absent on server', async () => {
  const content = Buffer.from('image data new');
  const dir = makeTmpProject({ 'logo.png': content });

  const fetchCalls = [];
  global.fetch = async (url, opts) => {
    fetchCalls.push({ url, method: opts?.method || 'GET' });
    if (url.includes('list-files')) return makeListResponse([]);
    if (url.includes('upload-file')) return makeUploadResponse();
    throw new Error(`Unexpected fetch: ${url}`);
  };

  const count = await uploadAssetsWithToken('token', 42, dir, null);
  fs.rmSync(dir, { recursive: true });

  assert.equal(count, 1, 'should upload 1 file');
  const uploadCalls = fetchCalls.filter((c) => c.url.includes('upload-file'));
  const deleteCalls = fetchCalls.filter((c) => c.url.includes('delete-file'));
  assert.equal(uploadCalls.length, 1, 'one upload fetch');
  assert.equal(deleteCalls.length, 0, 'no delete fetch');
});

test('uploadAssetsWithToken (b): skips when hash matches', async () => {
  const content = Buffer.from('unchanged image bytes');
  const hash = localHash(content);
  const dir = makeTmpProject({ 'logo.png': content });

  const fetchCalls = [];
  global.fetch = async (url, opts) => {
    fetchCalls.push({ url, method: opts?.method || 'GET' });
    if (url.includes('list-files')) {
      return makeListResponse([{ filename: 'logo.png', id: 7, content_hash: hash }]);
    }
    throw new Error(`Unexpected fetch: ${url}`);
  };

  const count = await uploadAssetsWithToken('token', 42, dir, null);
  fs.rmSync(dir, { recursive: true });

  assert.equal(count, 0, 'should skip — hash matches');
  assert.equal(fetchCalls.filter((c) => c.url.includes('upload-file')).length, 0);
  assert.equal(fetchCalls.filter((c) => c.url.includes('delete-file')).length, 0);
});

test('uploadAssetsWithToken (c): deletes then uploads when hash differs', async () => {
  const content = Buffer.from('new image bytes');
  const differentHash = localHash(Buffer.from('old image bytes'));
  const dir = makeTmpProject({ 'logo.png': content });

  const fetchCalls = [];
  global.fetch = async (url, opts) => {
    fetchCalls.push({ url, method: opts?.method || 'GET' });
    if (url.includes('list-files')) {
      return makeListResponse([{ filename: 'logo.png', id: 7, content_hash: differentHash }]);
    }
    if (url.includes('delete-file')) return makeDeleteResponse();
    if (url.includes('upload-file')) return makeUploadResponse();
    throw new Error(`Unexpected fetch: ${url}`);
  };

  const count = await uploadAssetsWithToken('token', 42, dir, null);
  fs.rmSync(dir, { recursive: true });

  assert.equal(count, 1, 'should upload 1 file');
  const deleteIdx = fetchCalls.findIndex((c) => c.url.includes('delete-file'));
  const uploadIdx = fetchCalls.findIndex((c) => c.url.includes('upload-file'));
  assert.ok(deleteIdx !== -1, 'delete fetch must happen');
  assert.ok(uploadIdx !== -1, 'upload fetch must happen');
  assert.ok(deleteIdx < uploadIdx, 'delete must precede upload');
});

test('uploadAssetsWithToken (e): throws when list-files fails (no silent re-upload)', async () => {
  const dir = makeTmpProject({ 'logo.png': Buffer.from('whatever') });

  global.fetch = async (url) => {
    if (url.includes('list-files')) {
      return { ok: false, status: 503, text: async () => 'service unavailable' };
    }
    throw new Error(`Unexpected fetch before list-files resolves: ${url}`);
  };

  await assert.rejects(
    () => uploadAssetsWithToken('token', 42, dir, null),
    (err) => err.status === 503 && /Failed to list project files/.test(err.message),
  );
  fs.rmSync(dir, { recursive: true });
});

test('uploadAssetsWithToken (d): deletes then uploads when server hash is NULL', async () => {
  const content = Buffer.from('any image bytes');
  const dir = makeTmpProject({ 'logo.png': content });

  const fetchCalls = [];
  global.fetch = async (url, opts) => {
    fetchCalls.push({ url, method: opts?.method || 'GET' });
    if (url.includes('list-files')) {
      return makeListResponse([{ filename: 'logo.png', id: 8, content_hash: null }]);
    }
    if (url.includes('delete-file')) return makeDeleteResponse();
    if (url.includes('upload-file')) return makeUploadResponse();
    throw new Error(`Unexpected fetch: ${url}`);
  };

  const count = await uploadAssetsWithToken('token', 42, dir, null);
  fs.rmSync(dir, { recursive: true });

  assert.equal(count, 1, 'should upload 1 file (null hash treated as changed)');
  assert.ok(fetchCalls.some((c) => c.url.includes('delete-file')), 'delete must happen for null-hash row');
  assert.ok(fetchCalls.some((c) => c.url.includes('upload-file')), 'upload must happen');
});
