'use strict';
/**
 * Post diagnostics from upsert-post: the body-to-file line offset (checked
 * against gray-matter on real files) and the gcc-style report for push.
 */

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const matter = require('gray-matter');

const { reportPostDiagnostics, summarize } = require('../src/diagnostics');
const { bodyLineOffset, readLocalPost } = require('../src/commands/posts');

const splitLines = (s) => s.split(/\r\n|\r|\n/);

function writeTmp(name, text) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mp-post-diag-'));
  const file = path.join(dir, name);
  fs.writeFileSync(file, text);
  return file;
}

describe('bodyLineOffset', () => {
  const MARK = 'MARKER ![](x.png)';
  const cases = {
    'LF front-matter': ['---\ntitle: Hello\ndate: 2026-01-01\n---\nIntro\n\n' + MARK + '\n', 4],
    'CRLF front-matter': ['---\r\ntitle: Hello\r\ndate: 2026-01-01\r\n---\r\nIntro\r\n\r\n' + MARK + '\r\n', 4],
    'blank line after the closing delimiter': ['---\ntitle: Hello\n---\n\n' + MARK + '\n', 3],
    'CRLF blank line after the closing delimiter': ['---\r\ntitle: Hello\r\n---\r\n\r\n' + MARK + '\r\n', 3],
    'UTF-8 BOM': ['﻿---\ntitle: Hello\n---\n' + MARK + '\n', 3],
    'empty front-matter': ['---\n---\n' + MARK + '\n', 2],
    'comment-only front-matter': ['---\n# just a note\n---\n' + MARK + '\n', 3],
    'no front-matter': ['Intro\n' + MARK + '\n', 0],
    'body starts on the closing delimiter line break only': ['---\ntitle: Hello\n---\n' + MARK, 3],
  };

  for (const [name, [raw, expected]] of Object.entries(cases)) {
    test(`${name}: body line + offset is the file line`, () => {
      const file = writeTmp('post.md', raw);
      const text = fs.readFileSync(file, 'utf8');
      const parsed = matter(text, {}); // options bypass gray-matter's content cache
      const offset = bodyLineOffset(text, parsed.content);
      assert.equal(offset, expected);

      const bodyLine = splitLines(parsed.content).findIndex((l) => l.includes('MARKER')) + 1;
      const fileLine = splitLines(text).findIndex((l) => l.includes('MARKER')) + 1;
      assert.ok(bodyLine > 0);
      assert.equal(bodyLine + offset, fileLine);

      const post = readLocalPost(file);
      assert.equal(post.bodyLineOffset, expected);
      assert.equal(post.content, parsed.content);
    });
  }

  test('content that is not a suffix of the file falls back to 0', () => {
    assert.equal(bodyLineOffset('---\na: 1\n---\nbody', 'other'), 0);
    assert.equal(bodyLineOffset(undefined, undefined), 0);
  });
});

describe('reportPostDiagnostics', () => {
  function capture(diagnostics, opts = {}) {
    const out = [];
    reportPostDiagnostics(diagnostics, { file: 'posts/hello.md', lineOffset: 3, log: (l) => out.push(l), ...opts });
    return out;
  }

  const missingAlt = {
    line: 9,
    column: 1,
    severity: 'warning',
    code: 'missing-alt',
    message: 'This image has no alt text.',
  };

  test('prints gcc-style lines mapped to the post file, then a summary', () => {
    assert.deepEqual(capture([missingAlt, { ...missingAlt, line: 12, column: 5 }]), [
      'posts/hello.md:12:1: warning: This image has no alt text. [missing-alt]',
      'posts/hello.md:15:5: warning: This image has no alt text. [missing-alt]',
      'Post check reported 2 warnings.',
    ]);
  });

  test('a response without diagnostics, or with none, prints nothing', () => {
    assert.deepEqual(capture(undefined), []);
    assert.deepEqual(capture(null), []);
    assert.deepEqual(capture('nope'), []);
    assert.deepEqual(capture([]), []);
  });

  test('the truncation note has no line and is counted as truncation', () => {
    const out = capture([missingAlt, { severity: 'hint', code: 'too-many-diagnostics', message: '3 more not shown.' }]);
    assert.deepEqual(out, [
      'posts/hello.md:12:1: warning: This image has no alt text. [missing-alt]',
      'posts/hello.md: hint: 3 more not shown. [too-many-diagnostics]',
      'Post check reported 1 warning (more not shown).',
    ]);
  });

  test('malformed entries are skipped or rendered safely, never thrown', () => {
    const out = capture([
      null,
      42,
      ['x'],
      { line: 'seven', severity: 'fatal', message: { a: 1 } },
      { line: 2, column: -4, severity: 'warning', code: 'missing-alt', message: 'bad\u001b[31m\r\nalt' },
    ]);
    assert.deepEqual(out, [
      'posts/hello.md: hint: [object Object]',
      'posts/hello.md:5:1: warning: bad?[31m?alt [missing-alt]',
      'Post check reported 1 warning, 1 hint.',
    ]);
  });

  test('a whole-post note names the post and long messages are clipped', () => {
    const out = capture([
      { severity: 'hint', code: 'post-not-checked', message: 'Some of this post was not checked.' },
      { ...missingAlt, message: 'x'.repeat(1000) },
    ]);
    assert.equal(out[0], 'posts/hello.md: hint: Some of this post was not checked. [post-not-checked]');
    assert.equal(out[1], 'posts/hello.md:12:1: warning: ' + 'x'.repeat(300) + ' [missing-alt]');
  });

  test('caps output at 51 entries', () => {
    const many = Array.from({ length: 80 }, (_, i) => ({ ...missingAlt, line: i + 1 }));
    const out = capture(many);
    assert.equal(out.length, 52);
    assert.equal(out[51], 'Post check reported 51 warnings.');
  });

  test('bad lineOffset is treated as 0', () => {
    assert.equal(capture([missingAlt], { lineOffset: 'x' })[0], 'posts/hello.md:9:1: warning: This image has no alt text. [missing-alt]');
  });

  test('a throwing log does not escape', () => {
    let calls = 0;
    const log = () => {
      calls += 1;
      if (calls === 1) throw new Error('boom');
    };
    assert.doesNotThrow(() => reportPostDiagnostics([missingAlt], { file: 'p.md', log }));
    assert.equal(calls, 2);
  });

  test('summarize keeps the parser wording by default', () => {
    assert.equal(summarize([missingAlt]), 'Parser reported 1 warning.');
  });
});
