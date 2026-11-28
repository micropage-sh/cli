'use strict';
/**
 * Fix planning, raw rewriting and unified diffs (src/fixes.js) against real
 * files read through readPageFilesWithMap, including CRLF, BOM and the
 * whitespace that trimming removes. The diff is checked with `git apply`.
 */

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const { readPageFilesWithMap, readPageFilesFromDir } = require('../src/parser');
const { planFixes, applyFixesToRaw, renderUnifiedDiff } = require('../src/fixes');

function project(files) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mp-fixes-'));
  for (const [name, text] of Object.entries(files)) fs.writeFileSync(path.join(dir, name), text);
  return dir;
}

function load(dir) {
  return readPageFilesWithMap(dir, { keepRaw: true });
}

// A fix that replaces `from` with `to` on the merged line containing `from`.
function fixFor(map, from, to, extra = {}) {
  const line = map.text.split('\n').findIndex((l) => l.includes(from)) + 1;
  assert.ok(line > 0, `no merged line contains ${from}`);
  const current = map.text.split('\n')[line - 1].replace(/\r$/, '');
  return {
    line,
    column: 1,
    severity: 'hint',
    code: 'unknown-tag',
    message: 'Unknown tag',
    fix: { line, replace: current.replace(from, to) },
    ...extra,
  };
}

function applyAll(dir, map, fixes) {
  const out = {};
  for (const f of map.files) {
    const mine = fixes.filter((x) => x.file === f.name);
    out[f.name] = mine.length ? applyFixesToRaw(f.raw, mine) : f.raw;
  }
  return out;
}

function gitApply(dir, patch) {
  const opts = { cwd: dir, input: patch, stdio: ['pipe', 'pipe', 'pipe'] };
  execFileSync('git', ['init', '-q'], { cwd: dir });
  execFileSync('git', ['apply', '--check', '-'], opts);
  execFileSync('git', ['apply', '-'], opts);
}

describe('readPageFilesWithMap keepRaw', () => {
  test('default output has no raw and is unchanged', () => {
    const dir = project({ 'landing.page': '  hero\nx\n', 'b.page': '\n\nb\n' });
    const plain = readPageFilesWithMap(dir);
    const withRaw = load(dir);
    assert.equal(plain.files.some((f) => 'raw' in f), false);
    assert.equal(withRaw.text, plain.text);
    assert.deepEqual(withRaw.files.map(({ raw, bytes, utf8, ...rest }) => rest), plain.files);
    assert.equal(withRaw.files[0].raw, '  hero\nx\n');
    assert.equal(readPageFilesFromDir(dir), plain.text);
  });
});

describe('planFixes + applyFixesToRaw + renderUnifiedDiff', () => {
  const cases = {
    LF: { 'landing.page': 'a\nbuton: Go\nc\n' },
    CRLF: { 'landing.page': 'a\r\nbuton: Go\r\nc\r\n' },
    'BOM on the fixed first line': { 'landing.page': '﻿buton: Go\nb\n' },
    'first-line indent': { 'landing.page': '   buton: Go\nb\n' },
    'last-line trailing space, no final newline': { 'landing.page': 'a\nbuton: Go  ' },
    'CRLF last line with trailing space': { 'landing.page': 'a\r\nbuton: Go \r\n' },
    'second file with leading blank lines': {
      'landing.page': 'a\n',
      'more.page': '\n\n\nbuton: Go\nz\n',
    },
    'single-line file with indent and trailing space': { 'landing.page': '﻿  buton: Go \r\n' },
  };

  for (const [name, files] of Object.entries(cases)) {
    test(`${name}: only the fixed text changes; git apply agrees`, () => {
      const dir = project(files);
      const map = load(dir);
      const { fixes, skipped } = planFixes(map, map.text, [fixFor(map, 'buton', 'button')]);
      assert.deepEqual(skipped, []);
      assert.equal(fixes.length, 1);
      assert.equal(fixes[0].oldText.trim(), 'buton: Go');
      assert.equal(fixes[0].newText.trim(), 'button: Go');

      const expected = applyAll(dir, map, fixes);
      for (const [file, raw] of Object.entries(files)) {
        const want = raw.replace('buton', 'button');
        assert.equal(expected[file], want, `${file} rewritten exactly`);
      }

      const patch = renderUnifiedDiff(fixes, map);
      gitApply(dir, patch);
      for (const file of Object.keys(files)) {
        assert.equal(fs.readFileSync(path.join(dir, file), 'utf8'), expected[file]);
      }
    });
  }

  test('a fix carrying a trailing \\r is accepted and the line ending kept', () => {
    const dir = project({ 'landing.page': 'a\r\nbuton: Go\r\nc\r\n' });
    const map = load(dir);
    const d = fixFor(map, 'buton', 'button');
    d.fix.replace += '\r';
    const { fixes } = planFixes(map, map.text, [d]);
    assert.equal(applyFixesToRaw(map.files[0].raw, fixes), 'a\r\nbutton: Go\r\nc\r\n');
  });

  test('uses fix.line, not the diagnostic line', () => {
    const dir = project({ 'landing.page': 'a\nbuton: Go\nc\n' });
    const map = load(dir);
    const d = { ...fixFor(map, 'buton', 'button'), line: 3 };
    const { fixes } = planFixes(map, map.text, [d]);
    assert.equal(fixes[0].line, 2);
  });

  test('skips: separator line, duplicate line, control chars, no-op, invalid fixes ignored', () => {
    const dir = project({ 'landing.page': 'a\nbuton: Go\n', 'more.page': 'z\n' });
    const map = load(dir);
    const good = fixFor(map, 'buton', 'button');
    const diagnostics = [
      good,
      { ...good, fix: { line: 2, replace: 'buttton: Go' } },
      { ...good, fix: { line: 3, replace: 'x' } },
      { ...good, fix: { line: 4, replace: 'z\u001b[2J' } },
      { ...good, fix: { line: 4, replace: 'z' } },
      { ...good, fix: { line: 1, replace: 'a\nb' } },
      { ...good, fix: { line: 1, replace: 'x'.repeat(501) } },
      { ...good, fix: { line: 1.5, replace: 'x' } },
      { ...good, fix: null },
    ];
    const { fixes, skipped } = planFixes(map, map.text, diagnostics);
    assert.equal(fixes.length, 1);
    assert.equal(fixes[0].newText, 'button: Go');
    assert.deepEqual(skipped.map((s) => s.reason), [
      'another fix already changes this line',
      'the suggested line is not in any .page file',
      'the suggestion contains control characters',
      'the suggestion does not change the line',
    ]);
  });

  test('a tab in the replacement is allowed', () => {
    const dir = project({ 'landing.page': 'a\tb\n' });
    const map = load(dir);
    const { fixes } = planFixes(map, map.text, [{ severity: 'hint', code: 'c', message: 'm', fix: { line: 1, replace: 'a\tc' } }]);
    assert.equal(fixes.length, 1);
  });

  test('merged text that disagrees with the file skips as changed since the check', () => {
    const dir = project({ 'landing.page': 'a\nbuton: Go\n' });
    const map = load(dir);
    const d = fixFor(map, 'buton', 'button');
    const { fixes, skipped } = planFixes(map, 'a\nsomething else', [d]);
    assert.equal(fixes.length, 0);
    // The no-op/claim checks use the merged text; the raw check catches the mismatch.
    assert.match(skipped[0].reason, /changed since the check/);
  });

  test('applyFixesToRaw returns null when the fixed line changed', () => {
    const dir = project({ 'landing.page': 'a\nbuton: Go\n' });
    const map = load(dir);
    const { fixes } = planFixes(map, map.text, [fixFor(map, 'buton', 'button')]);
    assert.equal(applyFixesToRaw('a\nbuton: Stop\n', fixes), null);
    assert.equal(applyFixesToRaw('a\nbuton: Go\nmore\n', fixes), 'a\nbutton: Go\nmore\n');
  });

  test('near fixes share one hunk, far fixes get two; git apply reproduces both', () => {
    const lines = Array.from({ length: 30 }, (_, i) => `line${i + 1}`);
    const dir = project({ 'landing.page': `${lines.join('\n')}\n` });
    const map = load(dir);
    const ds = ['line3', 'line9', 'line25'].map((l) => fixFor(map, l, `${l}x`));
    const { fixes } = planFixes(map, map.text, ds);
    const patch = renderUnifiedDiff(fixes, map, { context: 3 });
    assert.deepEqual(patch.split('\n').filter((l) => l.startsWith('@@')), [
      '@@ -1,12 +1,12 @@',
      '@@ -22,7 +22,7 @@',
    ]);
    const expected = applyAll(dir, map, fixes);
    gitApply(dir, patch);
    assert.equal(fs.readFileSync(path.join(dir, 'landing.page'), 'utf8'), expected['landing.page']);
  });

  test('adjacent changed lines are grouped as - lines then + lines', () => {
    const dir = project({ 'landing.page': 'a\nb\nc\n' });
    const map = load(dir);
    const ds = [fixFor(map, 'a', 'A'), fixFor(map, 'b', 'B')];
    const { fixes } = planFixes(map, map.text, ds);
    const patch = renderUnifiedDiff(fixes, map);
    assert.equal(patch, [
      'diff --git a/landing.page b/landing.page',
      '--- a/landing.page',
      '+++ b/landing.page',
      '@@ -1,3 +1,3 @@',
      '-a',
      '-b',
      '+A',
      '+B',
      ' c',
      '',
    ].join('\n'));
  });

  test('no final newline is marked on both sides', () => {
    const dir = project({ 'landing.page': 'a\nb' });
    const map = load(dir);
    const { fixes } = planFixes(map, map.text, [fixFor(map, 'b', 'B')]);
    const patch = renderUnifiedDiff(fixes, map);
    assert.equal(patch, [
      'diff --git a/landing.page b/landing.page',
      '--- a/landing.page',
      '+++ b/landing.page',
      '@@ -1,2 +1,2 @@',
      ' a',
      '-b',
      '\\ No newline at end of file',
      '+B',
      '\\ No newline at end of file',
      '',
    ].join('\n'));
  });

  test('files whose names cannot appear in a patch are left out and reported', () => {
    const dir = project({ 'landing.page': 'a\n', 'we"ird.page': 'b\n' });
    const map = load(dir);
    const ds = [fixFor(map, 'a', 'A'), fixFor(map, 'b', 'B')];
    const { fixes } = planFixes(map, map.text, ds);
    const left = [];
    const patch = renderUnifiedDiff(fixes, map, { onSkip: (n) => left.push(n) });
    assert.deepEqual(left, ['we"ird.page']);
    assert.match(patch, /a\/landing\.page/);
    assert.doesNotMatch(patch, /ird/);
  });

  test('no fixes renders an empty string', () => {
    const dir = project({ 'landing.page': 'a\n' });
    assert.equal(renderUnifiedDiff([], load(dir)), '');
  });

  test('non-UTF-8 files (Latin-1, UTF-16 with and without BOM) get no fixes and no diff', () => {
    const files = {
      'landing.page': Buffer.concat([Buffer.from('caf'), Buffer.from([0xe9]), Buffer.from('\nbuton: Go\n')]),
      'b16.page': Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from('buton: B\n', 'utf16le')]),
      'c16.page': Buffer.from('buton: C\n', 'utf16le'),
    };
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mp-fixes-'));
    for (const [n, b] of Object.entries(files)) fs.writeFileSync(path.join(dir, n), b);
    const map = load(dir);
    assert.deepEqual(map.files.map((f) => f.utf8), [false, false, false]);
    const ds = map.text.split('\n').flatMap((l, i) => (l.includes('b\u0000u') || l.includes('buton')
      ? [{ severity: 'hint', code: 'x', message: 'm', fix: { line: i + 1, replace: 'button' } }]
      : []));
    assert.ok(ds.length >= 1);
    const { fixes, skipped } = planFixes(map, map.text, ds);
    assert.deepEqual(fixes, []);
    assert.ok(skipped.every((s) => / is not UTF-8; nothing written to it$/.test(s.reason)));
    assert.equal(renderUnifiedDiff(fixes, map), '');
  });

  test('UTF-8 with a BOM and multibyte text counts as UTF-8', () => {
    const dir = project({ 'landing.page': '\uFEFFcafé ☕\nbuton\n' });
    const map = load(dir);
    assert.equal(map.files[0].utf8, true);
    assert.ok(Buffer.isBuffer(map.files[0].bytes));
  });

  test('bidi overrides and isolates in a replacement are refused', () => {
    const dir = project({ 'landing.page': 'hello\n' });
    const map = load(dir);
    for (const ch of ['\u202a', '\u202e', '\u2066', '\u2069']) {
      const { fixes, skipped } = planFixes(map, map.text, [{ severity: 'hint', code: 'c', message: 'm', fix: { line: 1, replace: `he${ch}llo` } }]);
      assert.equal(fixes.length, 0);
      assert.equal(skipped[0].reason, 'the suggestion contains control characters');
    }
  });

  test('names with CR, ESC or bidi controls are left out of the diff; reasons are cleaned', () => {
    for (const bad of ['a\rb.page', 'a\u001b[2Jb.page', 'a\u202eb.page']) {
      const map = {
        text: 'x',
        files: [{ name: bad, startLine: 1, lineCount: 1, leadingLines: 0, raw: 'x\n', utf8: true }],
      };
      const { fixes } = planFixes(map, map.text, [{ severity: 'hint', code: 'c', message: 'm', fix: { line: 1, replace: 'y' } }]);
      assert.equal(fixes.length, 1);
      const left = [];
      assert.equal(renderUnifiedDiff(fixes, map, { onSkip: (n) => left.push(n) }), '');
      assert.deepEqual(left, [bad]);

      const changed = planFixes({ ...map, files: [{ ...map.files[0], raw: 'z\n' }] }, 'x', [{ severity: 'hint', code: 'c', message: 'm', fix: { line: 1, replace: 'y' } }]);
      assert.doesNotMatch(changed.skipped[0].reason, /[\u0000-\u001f\u202e]/);
    }
  });
});

