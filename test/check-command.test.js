'use strict';
/**
 * `micropage check` and `micropage fix` against a stubbed fetch: request
 * shape, exit codes, --json / --diff output, the interactive fix loop, and
 * that nothing but POST /check is ever called (no build rows, no uploads).
 */

const { test, describe, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { check, fix, createTerminalPrompt, NOT_A_TTY } = require('../src/commands/check');
const { PassThrough } = require('stream');
const { checkContent } = require('../src/check-api');
const { BUILD_COMPILER_URL } = require('../src/config');

const realFetch = globalThis.fetch;
let calls;

// Diagnoses the text it receives: `buton` lines get a fixable hint, ERR an
// error, WARN a warning, `<- name` a missing file unless name is in local_files.
function fakeCompiler(body) {
  const diagnostics = [];
  body.text.split('\n').forEach((raw, i) => {
    const text = raw.replace(/\r$/, '');
    const line = i + 1;
    if (text.includes('buton')) {
      diagnostics.push({
        line, column: 1, severity: 'hint', code: 'unknown-tag', message: 'Unknown tag buton',
        fix: { line, replace: text.replace('buton', 'button') },
      });
    }
    if (text.includes('ERR')) diagnostics.push({ line, column: 1, severity: 'error', code: 'dropped-block', message: 'Bad block' });
    if (text.includes('WARN')) diagnostics.push({ line, column: 2, severity: 'warning', code: 'missing-alt', message: 'No alt' });
    const ref = text.match(/<-\s*(\S+\.\w+)\s*$/);
    if (ref && !(body.local_files || []).includes(ref[1])) {
      diagnostics.push({ line, column: 1, severity: 'error', code: 'unresolved-file', message: `No file ${ref[1]}` });
    }
  });
  return diagnostics;
}

function respond(status, json) {
  return new Response(typeof json === 'string' ? json : JSON.stringify(json), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

function stubFetch(handler = (body) => respond(200, { diagnostics: fakeCompiler(body) })) {
  globalThis.fetch = async (url, init = {}) => {
    const body = init.body ? JSON.parse(init.body) : null;
    calls.push({ url: String(url), method: init.method, headers: init.headers, body });
    return handler(body, calls.length);
  };
}

function project(files, { config = { projectId: 42 }, assets = [] } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mp-check-'));
  if (config) {
    fs.mkdirSync(path.join(dir, '.micropage'));
    fs.writeFileSync(path.join(dir, '.micropage', 'project.json'), JSON.stringify(config));
  }
  if (assets.length) {
    fs.mkdirSync(path.join(dir, 'assets'));
    for (const a of assets) fs.writeFileSync(path.join(dir, 'assets', a), 'x');
  }
  for (const [name, text] of Object.entries(files)) fs.writeFileSync(path.join(dir, name), text);
  return dir;
}

function io(extra = {}) {
  const out = [];
  const err = [];
  const raw = [];
  return {
    out,
    err,
    raw,
    deps: {
      stdout: (s) => out.push(s),
      stderr: (s) => err.push(s),
      write: (s) => raw.push(s),
      getToken: async () => 'tok',
      refresh: async () => null,
      ...extra,
    },
  };
}

function scripted(answers) {
  const asked = [];
  return {
    asked,
    ask: async (q) => {
      asked.push(q);
      return answers.length ? answers.shift() : null;
    },
    close() {},
  };
}

function snapshot(dir) {
  const out = {};
  for (const name of fs.readdirSync(dir)) {
    const p = path.join(dir, name);
    if (fs.statSync(p).isFile()) out[name] = fs.readFileSync(p, 'utf8');
  }
  out['.micropage/project.json'] = fs.existsSync(path.join(dir, '.micropage', 'project.json'))
    ? fs.readFileSync(path.join(dir, '.micropage', 'project.json'), 'utf8')
    : null;
  return out;
}

function onlyCheckCalls() {
  for (const c of calls) {
    assert.equal(c.url, `${BUILD_COMPILER_URL}/check`);
    assert.equal(c.method, 'POST');
  }
}

beforeEach(() => {
  calls = [];
  stubFetch();
});

afterEach(() => {
  globalThis.fetch = realFetch;
});

describe('checkContent', () => {
  test('posts text, project_id, local_files with the bearer token', async () => {
    const r = await checkContent({ text: 'a', projectId: 7, localFiles: ['x.png'], getToken: async () => 'tok' });
    assert.deepEqual(r, { diagnostics: [] });
    assert.equal(calls.length, 1);
    assert.equal(calls[0].headers.Authorization, 'Bearer tok');
    assert.deepEqual(calls[0].body, { text: 'a', project_id: 7, local_files: ['x.png'] });
  });

  test('401 refreshes once and retries with the new token', async () => {
    stubFetch((body, n) => (n === 1 ? respond(401, { error: 'Unauthorized' }) : respond(200, { diagnostics: [] })));
    await checkContent({ text: 'a', projectId: 7, getToken: async () => 'old', refresh: async () => ({ access_token: 'new' }) });
    assert.deepEqual(calls.map((c) => c.headers.Authorization), ['Bearer old', 'Bearer new']);
  });

  const errors = [
    [404, { error: 'Not found' }, 'CHECK_UNSUPPORTED', /doesn't support check yet/],
    [401, { error: 'Unauthorized' }, 'CHECK_UNAUTHORIZED', /micropage login/],
    [403, { error: 'Forbidden' }, 'CHECK_FORBIDDEN', /another account/],
    [413, { error: 'The page source is too large.' }, 'CHECK_REJECTED', /^The page source is too large\.$/],
    [422, { error: 'Too many table rows.' }, 'CHECK_REJECTED', /^Too many table rows\.$/],
    [502, 'bad gateway', 'CHECK_SERVER', /HTTP 502/],
    [200, { site: {} }, 'CHECK_BAD_RESPONSE', /unexpected response/],
  ];
  for (const [status, body, code, message] of errors) {
    test(`HTTP ${status} -> ${code}`, async () => {
      stubFetch(() => respond(status, body));
      await assert.rejects(checkContent({ text: 'a', projectId: 7, getToken: async () => 't', refresh: async () => null }), (e) => {
        assert.equal(e.code, code);
        assert.match(e.message, message);
        return true;
      });
    });
  }

  test('network failure -> CHECK_NETWORK', async () => {
    globalThis.fetch = async () => { throw new TypeError('fetch failed'); };
    await assert.rejects(checkContent({ text: 'a', projectId: 7, getToken: async () => 't' }), { code: 'CHECK_NETWORK' });
  });
});

describe('micropage check', () => {
  test('clean project prints No problems found and exits 0', async () => {
    const dir = project({ 'landing.page': 'hello\n' });
    const t = io();
    assert.equal(await check(dir, {}, t.deps), 0);
    assert.deepEqual(t.out, ['No problems found.']);
    onlyCheckCalls();
  });

  test('sends the merged text and asset basenames as local_files, as push names them', async () => {
    const dir = project(
      { 'landing.page': 'img: Hero <- photo.jpg\n', 'more.page': 'img: Other <- gone.png\n' },
      { assets: ['photo.jpg', '.DS_Store'] },
    );
    const t = io();
    assert.equal(await check(dir, {}, t.deps), 1);
    assert.deepEqual(calls[0].body, {
      text: 'img: Hero <- photo.jpg\n\nimg: Other <- gone.png',
      project_id: 42,
      local_files: ['photo.jpg'],
    });
    assert.deepEqual(t.out, ['more.page:1:1: error: No file gone.png [unresolved-file]', 'Check reported 1 error.']);
  });

  // Names over 255 characters can't be created on common filesystems, so
  // only the entry cap is exercised here.
  test('local_files is capped at 1000 entries', async () => {
    const names = Array.from({ length: 1002 }, (_, i) => `f${String(i).padStart(4, '0')}.png`);
    const dir = project({ 'landing.page': 'a\n' }, { assets: names });
    await check(dir, {}, io().deps);
    const sent = calls[0].body.local_files;
    assert.equal(sent.length, 1000);
    assert.ok(sent.every((n) => n.length <= 255));
  });

  test('exit-code matrix', async () => {
    const cases = [
      ['hello\n', {}, 0],
      ['buton: Go\n', {}, 0],
      ['buton: Go\n', { strict: true }, 0],
      ['WARN\n', {}, 0],
      ['WARN\n', { strict: true }, 1],
      ['ERR\n', {}, 1],
      ['ERR\n', { strict: true }, 1],
    ];
    for (const [text, opts, want] of cases) {
      const dir = project({ 'landing.page': text });
      assert.equal(await check(dir, opts, io().deps), want, `${JSON.stringify(text)} ${JSON.stringify(opts)}`);
    }
  });

  test('could-not-check cases exit 2', async () => {
    const noConfig = project({ 'landing.page': 'a\n' }, { config: null });
    let t = io();
    assert.equal(await check(noConfig, {}, t.deps), 2);
    assert.match(t.err[0], /\.micropage\/project\.json/);

    const noPages = project({});
    t = io();
    assert.equal(await check(noPages, {}, t.deps), 2);
    assert.match(t.err[0], /No \.page files/);

    const dir = project({ 'landing.page': 'a\n' });
    for (const [status, body, message] of [
      [404, {}, "This build compiler doesn't support check yet."],
      [401, { error: 'Unauthorized' }, 'micropage login'],
      [403, { error: 'Forbidden' }, 'another account'],
      [413, { error: 'Request body too large.' }, 'Request body too large.'],
      [422, { error: 'Too many rows.' }, 'Too many rows.'],
      [500, {}, 'HTTP 500'],
    ]) {
      stubFetch(() => respond(status, body));
      t = io();
      assert.equal(await check(dir, {}, t.deps), 2, `HTTP ${status}`);
      assert.ok(t.err.join('\n').includes(message), `HTTP ${status}: ${t.err}`);
      assert.deepEqual(t.out, []);
    }

    globalThis.fetch = async () => { throw new TypeError('fetch failed'); };
    t = io();
    assert.equal(await check(dir, {}, t.deps), 2);
    assert.match(t.err[0], /Could not reach/);
  });

  test('--json prints counts, truncated and file-mapped diagnostics', async () => {
    const dir = project({ 'landing.page': 'a\nbuton: Go\n', 'more.page': '\n\nERR\n' });
    stubFetch((body) => respond(200, {
      diagnostics: [...fakeCompiler(body), { severity: 'hint', code: 'too-many-diagnostics', message: 'More not shown' }],
    }));
    const t = io();
    assert.equal(await check(dir, { json: true }, t.deps), 1);
    assert.equal(t.out.length, 1);
    assert.deepEqual(JSON.parse(t.out[0]), {
      diagnostics: [
        {
          file: 'landing.page', line: 2, column: 1, severity: 'hint', code: 'unknown-tag', message: 'Unknown tag buton',
          fix: { file: 'landing.page', line: 2, replace: 'button: Go' },
        },
        { file: 'more.page', line: 3, column: 1, severity: 'error', code: 'dropped-block', message: 'Bad block' },
        { severity: 'hint', code: 'too-many-diagnostics', message: 'More not shown' },
      ],
      counts: { error: 1, warning: 0, hint: 1 },
      truncated: true,
    });
  });

  test('--json with --diff exits 2 without calling the server', async () => {
    const dir = project({ 'landing.page': 'a\n' });
    const t = io();
    assert.equal(await check(dir, { json: true, diff: true }, t.deps), 2);
    assert.equal(calls.length, 0);
  });

  test('--diff: stdout is only the patch, everything else on stderr', async () => {
    const dir = project({ 'landing.page': 'a\nbuton: Go\nERR\n' });
    const before = snapshot(dir);
    const t = io();
    assert.equal(await check(dir, { diff: true }, t.deps), 1);
    assert.deepEqual(t.out, []);
    assert.equal(t.raw.join(''), [
      'diff --git a/landing.page b/landing.page',
      '--- a/landing.page',
      '+++ b/landing.page',
      '@@ -1,3 +1,3 @@',
      ' a',
      '-buton: Go',
      '+button: Go',
      ' ERR',
      '',
    ].join('\n'));
    assert.ok(t.err.some((l) => l.startsWith('landing.page:3:1: error: Bad block')));
    assert.ok(t.err.includes('Check reported 1 error, 1 hint.'));
    assert.deepEqual(snapshot(dir), before);
  });

  test('never writes files or project.json and calls nothing but /check', async () => {
    const dir = project({ 'landing.page': 'buton: Go\nERR\n' }, { assets: ['a.png'], config: { projectId: 42, buildId: 9 } });
    const before = snapshot(dir);
    for (const opts of [{}, { json: true }, { diff: true }, { strict: true }]) await check(dir, opts, io().deps);
    assert.deepEqual(snapshot(dir), before);
    assert.equal(calls.length, 4);
    onlyCheckCalls();
  });
});

describe('micropage fix', () => {
  test('refuses without a terminal unless --yes, before any request', async () => {
    const dir = project({ 'landing.page': 'buton: Go\n' });
    const before = snapshot(dir);
    const t = io({ isTTY: false });
    assert.equal(await fix(dir, {}, t.deps), 2);
    assert.deepEqual(t.err, [NOT_A_TTY]);
    assert.equal(calls.length, 0);
    assert.deepEqual(snapshot(dir), before);
  });

  test('--yes applies every fix, prints each, re-checks exactly once', async () => {
    const dir = project({ 'landing.page': 'a\r\nbuton: Go\r\n', 'more.page': '  buton: B  \n' });
    const t = io({ isTTY: false });
    assert.equal(await fix(dir, { yes: true }, t.deps), 0);
    assert.equal(fs.readFileSync(path.join(dir, 'landing.page'), 'utf8'), 'a\r\nbutton: Go\r\n');
    assert.equal(fs.readFileSync(path.join(dir, 'more.page'), 'utf8'), '  button: B  \n');
    assert.equal(calls.length, 2);
    onlyCheckCalls();
    assert.ok(t.out.includes('Fix 1 of 2: landing.page:2:1: hint: Unknown tag buton [unknown-tag]'));
    assert.ok(t.out.includes('  old: buton: Go'));
    assert.ok(t.out.includes('  new: button: Go'));
    assert.ok(t.out.includes('Wrote 1 fix to more.page.'));
    assert.equal(t.out[t.out.length - 1], 'No problems found.');
  });

  test('keeps the file mode and BOM', async () => {
    const dir = project({ 'landing.page': '﻿buton: Go\n' });
    fs.chmodSync(path.join(dir, 'landing.page'), 0o640);
    await fix(dir, { yes: true }, io().deps);
    assert.equal(fs.readFileSync(path.join(dir, 'landing.page'), 'utf8'), '﻿button: Go\n');
    assert.equal(fs.statSync(path.join(dir, 'landing.page')).mode & 0o777, 0o640);
    assert.deepEqual(fs.readdirSync(dir).filter((n) => n.endsWith('.tmp')), []);
  });

  test('scripted y / n / ? / junk, then a', async () => {
    const dir = project({ 'landing.page': 'buton: 1\nbuton: 2\nbuton: 3\nbuton: 4\n' });
    const prompt = scripted(['y', 'n', '?', 'what', 'a']);
    const t = io({ isTTY: true, prompt });
    assert.equal(await fix(dir, {}, t.deps), 0);
    assert.equal(prompt.asked.length, 5);
    assert.ok(prompt.asked.every((q) => q === 'Apply this fix? [y,n,a,q,?] '));
    assert.ok(t.out.includes('a - apply this fix and every remaining fix'));
    assert.equal(fs.readFileSync(path.join(dir, 'landing.page'), 'utf8'), 'button: 1\nbuton: 2\nbutton: 3\nbutton: 4\n');
    assert.equal(calls.length, 2);
  });

  test('q stops and keeps what was accepted', async () => {
    const dir = project({ 'landing.page': 'buton: 1\nbuton: 2\nbuton: 3\n' });
    const prompt = scripted(['y', 'q']);
    await fix(dir, {}, io({ isTTY: true, prompt }).deps);
    assert.equal(prompt.asked.length, 2);
    assert.equal(fs.readFileSync(path.join(dir, 'landing.page'), 'utf8'), 'button: 1\nbuton: 2\nbuton: 3\n');
  });

  test('EOF aborts and writes nothing, even after y', async () => {
    const dir = project({ 'landing.page': 'buton: 1\nbuton: 2\n' });
    const before = snapshot(dir);
    const t = io({ isTTY: true, prompt: scripted(['y']) });
    assert.equal(await fix(dir, {}, t.deps), 2);
    assert.deepEqual(snapshot(dir), before);
    assert.equal(calls.length, 1);
  });

  test('all declined: nothing written, no re-check, exit from the first check', async () => {
    const dir = project({ 'landing.page': 'buton: 1\nERR\n' });
    const t = io({ isTTY: true, prompt: scripted(['n']) });
    assert.equal(await fix(dir, {}, t.deps), 1);
    assert.equal(calls.length, 1);
  });

  test('a file changed while prompting is skipped whole; others are written', async () => {
    const dir = project({ 'landing.page': 'buton: 1\nbuton: 2\n', 'more.page': 'buton: m\n' });
    const prompt = {
      n: 0,
      async ask() {
        if (this.n++ === 0) fs.writeFileSync(path.join(dir, 'landing.page'), 'buton: 1\nbuton: edited\n');
        return 'y';
      },
      close() {},
    };
    const t = io({ isTTY: true, prompt });
    await fix(dir, {}, t.deps);
    assert.ok(t.out.includes('landing.page changed since the check; nothing written to it.'));
    assert.equal(fs.readFileSync(path.join(dir, 'landing.page'), 'utf8'), 'buton: 1\nbuton: edited\n');
    assert.equal(fs.readFileSync(path.join(dir, 'more.page'), 'utf8'), 'button: m\n');
    assert.equal(calls.length, 2);
  });

  test('remaining problems after fixing decide the exit code', async () => {
    const dir = project({ 'landing.page': 'buton: Go\nERR\n' });
    const t = io();
    assert.equal(await fix(dir, { yes: true }, t.deps), 1);
    assert.equal(calls.length, 2);
    assert.ok(t.out.slice(-2).includes('landing.page:2:1: error: Bad block [dropped-block]'));
  });

  test('a failed re-check exits 2 and says the fixes were written', async () => {
    const dir = project({ 'landing.page': 'buton: Go\n' });
    stubFetch((body, n) => (n === 1 ? respond(200, { diagnostics: fakeCompiler(body) }) : respond(503, {})));
    const t = io();
    assert.equal(await fix(dir, { yes: true }, t.deps), 2);
    assert.equal(fs.readFileSync(path.join(dir, 'landing.page'), 'utf8'), 'button: Go\n');
    assert.match(t.err[0], /Fixes were written, but the second check failed/);
  });

  test('no fixable diagnostics: no prompt, no re-check', async () => {
    const dir = project({ 'landing.page': 'ERR\n' });
    const prompt = scripted([]);
    const t = io({ isTTY: true, prompt });
    assert.equal(await fix(dir, {}, t.deps), 1);
    assert.equal(prompt.asked.length, 0);
    assert.ok(t.out.includes('No fixes to apply.'));
    assert.equal(calls.length, 1);
  });

  test('a Latin-1 file is never rewritten; other files still are', async () => {
    const latin1 = Buffer.concat([Buffer.from('caf'), Buffer.from([0xe9]), Buffer.from('\nbuton: Go\n')]);
    const dir = project({ 'more.page': 'buton: m\n' });
    fs.writeFileSync(path.join(dir, 'landing.page'), latin1);
    const t = io();
    await fix(dir, { yes: true }, t.deps);
    assert.ok(fs.readFileSync(path.join(dir, 'landing.page')).equals(latin1));
    assert.equal(fs.readFileSync(path.join(dir, 'more.page'), 'utf8'), 'button: m\n');
    assert.ok(t.out.some((l) => /landing\.page is not UTF-8; nothing written to it/.test(l)));
  });

  test('a UTF-16 file is never rewritten', async () => {
    const utf16 = Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from('buton: Go\n', 'utf16le')]);
    const dir = project({});
    fs.writeFileSync(path.join(dir, 'landing.page'), utf16);
    stubFetch(() => respond(200, { diagnostics: [{ line: 1, severity: 'hint', code: 'x', message: 'm', fix: { line: 1, replace: 'button: Go' } }] }));
    await fix(dir, { yes: true }, io().deps);
    assert.ok(fs.readFileSync(path.join(dir, 'landing.page')).equals(utf16));
    assert.equal(calls.length, 1);
  });

  test('--diff leaves a non-UTF-8 file out with a note on stderr', async () => {
    const dir = project({ 'more.page': 'buton: m\n' });
    fs.writeFileSync(path.join(dir, 'landing.page'), Buffer.concat([Buffer.from([0xe9]), Buffer.from('\nbuton: Go\n')]));
    const t = io();
    await check(dir, { diff: true }, t.deps);
    const patch = t.raw.join('');
    assert.match(patch, /^diff --git a\/more\.page b\/more\.page$/m);
    assert.doesNotMatch(patch, /landing/);
    assert.ok(t.err.some((l) => /landing\.page is not UTF-8/.test(l)));
  });

  test('a change anywhere in the file, not just the fixed line, makes it stale', async () => {
    const dir = project({ 'landing.page': 'buton: 1\nother\n' });
    const prompt = {
      async ask() {
        fs.writeFileSync(path.join(dir, 'landing.page'), 'buton: 1\nother edited\n');
        return 'y';
      },
      close() {},
    };
    const t = io({ isTTY: true, prompt });
    await fix(dir, {}, t.deps);
    assert.equal(fs.readFileSync(path.join(dir, 'landing.page'), 'utf8'), 'buton: 1\nother edited\n');
    assert.ok(t.out.includes('landing.page changed since the check; nothing written to it.'));
    assert.equal(calls.length, 1);
  });

  test('a read-only file is skipped with a note, not replaced', { skip: process.getuid && process.getuid() === 0 }, async () => {
    const dir = project({ 'landing.page': 'buton: Go\n' });
    fs.chmodSync(path.join(dir, 'landing.page'), 0o444);
    const t = io();
    await fix(dir, { yes: true }, t.deps);
    assert.equal(fs.readFileSync(path.join(dir, 'landing.page'), 'utf8'), 'buton: Go\n');
    assert.ok(t.out.includes('landing.page is read-only; nothing written to it.'));
    assert.equal(fs.statSync(path.join(dir, 'landing.page')).mode & 0o777, 0o444);
  });

  test('a failed write leaves no temp file behind and exits 2', { skip: process.getuid && process.getuid() === 0 }, async () => {
    const dir = project({ 'landing.page': 'buton: Go\n' });
    fs.chmodSync(dir, 0o555);
    const t = io();
    try {
      assert.equal(await fix(dir, { yes: true }, t.deps), 2);
    } finally {
      fs.chmodSync(dir, 0o755);
    }
    assert.match(t.err.join('\n'), /Could not write landing\.page/);
    assert.deepEqual(fs.readdirSync(dir).filter((n) => n.endsWith('.tmp')), []);
    assert.equal(fs.readFileSync(path.join(dir, 'landing.page'), 'utf8'), 'buton: Go\n');
  });
});

describe('createTerminalPrompt', () => {
  test('answers typed or pasted ahead are kept for the next questions', async () => {
    const input = new PassThrough();
    const output = new PassThrough();
    output.resume();
    const p = createTerminalPrompt({ input, output, terminal: false });
    input.write('y\nn\na\n');
    await new Promise((r) => setImmediate(r));
    assert.equal(await p.ask('Q? '), 'y');
    assert.equal(await p.ask('Q? '), 'n');
    assert.equal(await p.ask('Q? '), 'a');
    const later = p.ask('Q? ');
    input.write('q\n');
    assert.equal(await later, 'q');
    input.end();
    assert.equal(await p.ask('Q? '), null);
    p.close();
  });
});


describe('cli entry point', () => {
  test('an unexpected throw in check or fix exits 2 with a message, never 1', () => {
    const { spawnSync } = require('child_process');
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mp-check-cli-'));
    const preload = path.join(dir, 'boom.js');
    fs.writeFileSync(preload, `const m = require(${JSON.stringify(path.join(__dirname, '..', 'src', 'commands', 'check.js'))});
m.check = async () => { throw new Error('boom'); };
m.fix = async () => { throw new Error('boom'); };
`);
    for (const cmd of ['check', 'fix']) {
      const r = spawnSync(process.execPath, ['-r', preload, path.join(__dirname, '..', 'bin', 'micropage.js'), cmd, dir], { encoding: 'utf8' });
      assert.equal(r.status, 2, `${cmd}: ${r.stderr}`);
      assert.match(r.stderr, /micropage: boom/);
    }
  });
});
