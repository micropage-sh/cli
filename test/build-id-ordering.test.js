'use strict';
/**
 * The parser stamps the build_id it is given into json_content, so push and
 * the deploy-token push must create (or pick) the build row before parsing
 * and pass that row's id. Network and database calls are stubbed.
 */

const { test, describe, before, beforeEach, after, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'micropage-cli-test-'));
process.env.HOME = tmpHome;
process.env.USERPROFILE = tmpHome;

const supabase = require('../src/supabase');

class ExitCalled extends Error {
  constructor(code) {
    super(`process.exit(${code})`);
    this.code = code;
  }
}

after(() => {
  fs.rmSync(tmpHome, { recursive: true, force: true });
});

function jsonResponse(status, body) {
  return new Response(body === undefined ? '' : JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

/** In-memory `builds` / `projects` tables behind the db.from() builder shape. */
function makeFakeDb(builds) {
  const ops = [];
  const behavior = { emptyInsert: false, failBuildUpdate: false };
  let nextId = 500;
  const from = (table) => {
    const filters = {};
    const q = {
      select() { return q; },
      eq(col, val) { filters[col] = val; return q; },
      async single() {
        ops.push({ table, op: 'select', filters: { ...filters } });
        return builds.find((b) => String(b.id) === String(filters.id)) || null;
      },
      async insert(data) {
        ops.push({ table, op: 'insert', data });
        if (behavior.emptyInsert) return [];
        const row = { id: nextId++, number: builds.length + 1, ...data };
        builds.push(row);
        return [row];
      },
      async update(data) {
        ops.push({ table, op: 'update', data, filters: { ...filters } });
        if (table !== 'builds') return [];
        if (behavior.failBuildUpdate) throw new Error('update rejected');
        const row = builds.find((b) => String(b.id) === String(filters.id));
        if (!row) return [];
        Object.assign(row, data);
        return [row];
      },
    };
    return q;
  };
  return { from, ops, behavior };
}

describe('build push parses with the target build id', () => {
  let dir;
  let out;
  let builds;
  let fakeDb;
  let parseBodies;
  let invocations;
  let parseStatus;
  let failDeleteBuild;
  let buildsCmd;
  const originalCwd = process.cwd();
  const saved = {};

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'micropage-cli-push-'));
    fs.mkdirSync(path.join(dir, '.micropage'));
    fs.writeFileSync(path.join(dir, 'site.page'), '[Home -> /]\n\n/// hero\nh1: Hi\n');
    process.chdir(dir);

    builds = [];
    fakeDb = makeFakeDb(builds);
    parseBodies = [];
    invocations = [];
    parseStatus = 200;
    failDeleteBuild = false;
    out = [];

    saved.from = supabase.db.from;
    saved.invoke = supabase.fn.invoke;
    saved.token = supabase.getValidAccessToken;
    saved.upload = supabase.uploadAssetsWithToken;
    saved.exit = process.exit;
    saved.log = console.log;
    saved.error = console.error;
    saved.fetch = global.fetch;

    supabase.db.from = fakeDb.from;
    supabase.fn.invoke = async (name, body) => {
      invocations.push({ name, body });
      if (failDeleteBuild && name === 'delete-build') throw new Error('publisher unavailable');
      return {};
    };
    supabase.getValidAccessToken = async () => 'token';
    supabase.uploadAssetsWithToken = async () => 0;
    global.fetch = async (url, options) => {
      if (String(url).endsWith('/parse')) {
        parseBodies.push(JSON.parse(options.body));
        if (parseStatus !== 200) return new Response('boom', { status: parseStatus });
        return jsonResponse(200, { pages: [] });
      }
      throw new Error(`unexpected fetch ${url}`);
    };
    process.exit = (code) => {
      throw new ExitCalled(code);
    };
    console.log = (...a) => out.push(a.join(' '));
    console.error = (...a) => out.push(a.join(' '));

    // builds.js destructures the supabase helpers at require time.
    delete require.cache[require.resolve('../src/commands/builds')];
    buildsCmd = require('../src/commands/builds');
  });

  afterEach(() => {
    supabase.db.from = saved.from;
    supabase.fn.invoke = saved.invoke;
    supabase.getValidAccessToken = saved.token;
    supabase.uploadAssetsWithToken = saved.upload;
    process.exit = saved.exit;
    console.log = saved.log;
    console.error = saved.error;
    global.fetch = saved.fetch;
    process.chdir(originalCwd);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  function writeConfig(cfg) {
    fs.writeFileSync(path.join(dir, '.micropage', 'project.json'), JSON.stringify(cfg));
  }

  function readConfig() {
    return JSON.parse(fs.readFileSync(path.join(dir, '.micropage', 'project.json'), 'utf8'));
  }

  async function run(fnToRun) {
    try {
      await fnToRun();
      return 0;
    } catch (err) {
      if (err instanceof ExitCalled) return err.code;
      throw err;
    }
  }

  test('new build: row is inserted before parsing and the parser gets its id', async () => {
    builds.push({ id: 7, number: 1, status: 'deployed' });
    writeConfig({ projectId: 3, buildId: 7 });

    assert.equal(await run(() => buildsCmd.push()), 0);

    const insertIdx = fakeDb.ops.findIndex((o) => o.op === 'insert' && o.table === 'builds');
    assert.ok(insertIdx >= 0, 'a build row was inserted');
    const inserted = fakeDb.ops[insertIdx].data;
    assert.equal(inserted.json_content, undefined, 'json_content is filled in after parsing');
    assert.match(inserted.raw_content, /h1: Hi/);

    const newBuild = builds.find((b) => b.id !== 7);
    assert.equal(parseBodies.length, 1);
    assert.equal(parseBodies[0].build_id, newBuild.id);
    assert.notEqual(parseBodies[0].build_id, 7, 'not the previous build id');

    const update = fakeDb.ops.find((o) => o.op === 'update' && o.table === 'builds');
    assert.ok(fakeDb.ops.indexOf(update) > insertIdx);
    assert.equal(String(update.filters.id), String(newBuild.id));
    assert.deepEqual(update.data, { json_content: { pages: [] } });

    assert.ok(out.includes(`Created build v${newBuild.number}.`));
    assert.equal(readConfig().buildId, newBuild.id);
  });

  test('no previous build: creates one and parses with its id', async () => {
    writeConfig({ projectId: 3 });

    assert.equal(await run(() => buildsCmd.push()), 0);
    assert.equal(builds.length, 1);
    assert.equal(parseBodies[0].build_id, builds[0].id);
    assert.deepEqual(builds[0].json_content, { pages: [] });
  });

  test('existing draft: no insert, parser gets the draft id', async () => {
    builds.push({ id: 42, number: 4, status: 'draft' });
    writeConfig({ projectId: 3, buildId: 42 });

    assert.equal(await run(() => buildsCmd.push()), 0);
    assert.equal(fakeDb.ops.filter((o) => o.op === 'insert').length, 0);
    assert.equal(parseBodies[0].build_id, 42);
    const update = fakeDb.ops.find((o) => o.op === 'update' && o.table === 'builds');
    assert.equal(String(update.filters.id), '42');
    assert.deepEqual(update.data.json_content, { pages: [] });
    assert.ok(out.includes('Updated build v4.'));
  });

  test('parse failure on a new build removes the empty row', async () => {
    writeConfig({ projectId: 3 });
    parseStatus = 500;

    assert.equal(await run(() => buildsCmd.push()), 1);
    const newBuild = builds[0];
    assert.deepEqual(invocations, [{ name: 'delete-build', body: { build_id: newBuild.id } }]);
    assert.ok(out.some((l) => l.startsWith('Parse failed:')));
    assert.equal(readConfig().buildId, undefined, 'config not pointed at the discarded build');
  });

  test('json_content update failure on a new build removes the row and exits 1', async () => {
    writeConfig({ projectId: 3 });
    fakeDb.behavior.failBuildUpdate = true;

    assert.equal(await run(() => buildsCmd.push()), 1);
    assert.deepEqual(invocations, [{ name: 'delete-build', body: { build_id: builds[0].id } }]);
    assert.ok(out.includes('Push failed: update rejected'));
    assert.equal(readConfig().buildId, undefined);
  });

  test('delete-build failure during cleanup is only logged; the parse error is kept', async () => {
    writeConfig({ projectId: 3 });
    parseStatus = 500;
    failDeleteBuild = true;

    assert.equal(await run(() => buildsCmd.push()), 1);
    assert.equal(invocations.length, 1);
    assert.ok(out.some((l) => l.startsWith('Parse failed: Parser error: boom')));
    assert.ok(out.some((l) => /Could not remove the empty draft build .*publisher unavailable/.test(l)));
  });

  test('insert returning no row exits 1 without parsing or cleanup', async () => {
    writeConfig({ projectId: 3 });
    fakeDb.behavior.emptyInsert = true;

    assert.equal(await run(() => buildsCmd.push()), 1);
    assert.equal(parseBodies.length, 0);
    assert.deepEqual(invocations, []);
    assert.ok(out.some((l) => l.startsWith('Push failed:')));
  });

  test('parse failure on an existing draft keeps the draft', async () => {
    builds.push({ id: 42, number: 4, status: 'draft' });
    writeConfig({ projectId: 3, buildId: 42 });
    parseStatus = 500;

    assert.equal(await run(() => buildsCmd.push()), 1);
    assert.deepEqual(invocations, []);
  });
});

describe('pushWithToken creates the build before parsing', () => {
  const saved = {};
  let calls;
  let parseStatus;
  let insertBody;
  let patchStatus;
  let deleteStatus;
  let logged;

  before(() => {
    saved.error = console.error;
  });

  beforeEach(() => {
    calls = [];
    parseStatus = 200;
    insertBody = [{ id: 900, number: 12, status: 'draft' }];
    patchStatus = 200;
    deleteStatus = 200;
    logged = [];
    saved.fetch = global.fetch;
    console.error = (...a) => logged.push(a.join(' '));
    global.fetch = async (url, options) => {
      const u = String(url);
      const body = options.body ? JSON.parse(options.body) : null;
      calls.push({ url: u, method: options.method, body });
      if (u.endsWith('/rest/v1/builds') && options.method === 'POST') {
        return jsonResponse(201, insertBody);
      }
      if (u.endsWith('/parse')) {
        if (parseStatus !== 200) return new Response('bad markup', { status: parseStatus });
        return jsonResponse(200, { pages: [] });
      }
      if (u.includes('/rest/v1/builds?id=eq.900') && options.method === 'PATCH') {
        if (patchStatus !== 200) return jsonResponse(patchStatus, { message: 'update rejected' });
        return jsonResponse(200, [{ id: 900, number: 12, status: 'draft' }]);
      }
      if (u.endsWith('/functions/v1/delete-build')) {
        if (deleteStatus !== 200) return jsonResponse(deleteStatus, { error: 'publisher unavailable' });
        return jsonResponse(200, { success: true });
      }
      throw new Error(`unexpected fetch ${options.method} ${u}`);
    };
  });

  afterEach(() => {
    global.fetch = saved.fetch;
    console.error = saved.error;
  });

  test('inserts, parses with the new build id, then stores json_content', async () => {
    const build = await supabase.pushWithToken('jwt', 3, 'raw', 'https://compiler.test');

    assert.deepEqual(build, { id: 900, number: 12, status: 'draft' });
    assert.deepEqual(
      calls.map((c) => c.method),
      ['POST', 'POST', 'PATCH'],
    );
    assert.equal(calls[0].body.json_content, undefined);
    assert.equal(calls[1].url, 'https://compiler.test/parse');
    assert.equal(calls[1].body.build_id, 900);
    assert.deepEqual(calls[2].body, { json_content: { pages: [] } });
  });

  test('parse failure removes the new build and rethrows', async () => {
    parseStatus = 422;
    await assert.rejects(
      supabase.pushWithToken('jwt', 3, 'raw', 'https://compiler.test'),
      /Parser error: bad markup/,
    );
    const del = calls.find((c) => c.url.endsWith('/functions/v1/delete-build'));
    assert.deepEqual(del.body, { build_id: 900 });
    assert.equal(calls.filter((c) => c.method === 'PATCH').length, 0);
  });

  test('json_content update failure removes the new build and rethrows', async () => {
    patchStatus = 400;
    await assert.rejects(
      supabase.pushWithToken('jwt', 3, 'raw', 'https://compiler.test'),
      /update rejected/,
    );
    const del = calls.find((c) => c.url.endsWith('/functions/v1/delete-build'));
    assert.deepEqual(del.body, { build_id: 900 });
  });

  test('delete-build failure is only logged; the original error is rethrown', async () => {
    parseStatus = 422;
    deleteStatus = 500;
    await assert.rejects(
      supabase.pushWithToken('jwt', 3, 'raw', 'https://compiler.test'),
      /Parser error: bad markup/,
    );
    assert.ok(logged.some((l) => /Could not remove the empty draft build \(id 900\).*publisher unavailable/.test(l)));
  });

  test('insert returning no row throws a clear error without parsing', async () => {
    insertBody = [];
    await assert.rejects(
      supabase.pushWithToken('jwt', 3, 'raw', 'https://compiler.test'),
      /new build was not returned/,
    );
    assert.equal(calls.length, 1);
  });
});
