'use strict';
/**
 * Unit tests for the pure filesystem helpers in cli/src/parser.js.
 *
 * Scope: reads a temp dir; no Supabase / network.
 */

const { test, describe, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { readLlmsTxtFromDir, readPageFilesFromDir, readPageFilesWithMap, mapLine } = require('../src/parser');

// ---------------------------------------------------------------------------
// readLlmsTxtFromDir
// ---------------------------------------------------------------------------

describe('readLlmsTxtFromDir', () => {
  let dir;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'micropage-llms-'));
  });

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  test('returns the content when llms.txt is present', () => {
    const content = '# My site\n\n- [Home](/): the landing page\n';
    fs.writeFileSync(path.join(dir, 'llms.txt'), content, 'utf8');
    // Only the trailing newline is dropped; interior content is preserved.
    assert.equal(readLlmsTxtFromDir(dir), '# My site\n\n- [Home](/): the landing page');
  });

  test('returns null when llms.txt is absent', () => {
    assert.equal(readLlmsTxtFromDir(dir), null);
  });

  test('returns null when llms.txt is whitespace-only', () => {
    fs.writeFileSync(path.join(dir, 'llms.txt'), '   \n\t\n  ', 'utf8');
    assert.equal(readLlmsTxtFromDir(dir), null);
  });
});

// ---------------------------------------------------------------------------
// readPageFilesWithMap / mapLine
// ---------------------------------------------------------------------------

describe('readPageFilesWithMap', () => {
  let dir;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'micropage-map-'));
  });

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  function write(name, content) {
    fs.writeFileSync(path.join(dir, name), content, 'utf8');
  }

  // Every non-separator line of the merged text must map to the same text in
  // its source file.
  function assertRoundTrip(map) {
    const merged = map.text.split('\n');
    merged.forEach((text, i) => {
      const loc = mapLine(map, i + 1);
      if (!loc) {
        assert.equal(text, '', `unmapped line ${i + 1} is a blank separator`);
        return;
      }
      const src = fs.readFileSync(path.join(dir, loc.file), 'utf8').split('\n');
      assert.equal(src[loc.line - 1].trim(), text.trim(), `line ${i + 1} -> ${loc.file}:${loc.line}`);
    });
  }

  test('text matches readPageFilesFromDir and the old merge rules', () => {
    write('landing.page', '\n[Home -> /]\n/// hero\nh1: Hi\n\n');
    write('b.page', '  \n\n[About -> /about]\nh1: About\n');
    write('a.page', '[Docs -> /docs]\n');
    const map = readPageFilesWithMap(dir);
    assert.equal(map.text, readPageFilesFromDir(dir));
    assert.equal(
      map.text,
      '[Home -> /]\n/// hero\nh1: Hi\n\n[Docs -> /docs]\n\n[About -> /about]\nh1: About',
    );
    assert.deepEqual(map.files.map((f) => f.name), ['landing.page', 'a.page', 'b.page']);
  });

  test('leading blank lines in the second file', () => {
    write('landing.page', '[Home -> /]\nh1: Hi\n');
    write('more.page', '\n\n\n[About -> /about]\n/// hero\nimg: <- x.png\n');
    const map = readPageFilesWithMap(dir);
    assert.deepEqual(map.files, [
      { name: 'landing.page', startLine: 1, lineCount: 2, leadingLines: 0 },
      { name: 'more.page', startLine: 4, lineCount: 3, leadingLines: 3 },
    ]);
    assert.deepEqual(mapLine(map, 6), { file: 'more.page', line: 6 });
    assertRoundTrip(map);
  });

  test('empty landing.page is kept and occupies one line', () => {
    write('landing.page', '  \n\n');
    write('x.page', '[Home -> /]\nh1: Hi');
    const map = readPageFilesWithMap(dir);
    assert.equal(map.text, '\n\n[Home -> /]\nh1: Hi');
    assert.deepEqual(map.files[1], { name: 'x.page', startLine: 3, lineCount: 2, leadingLines: 0 });
    assert.deepEqual(mapLine(map, 3), { file: 'x.page', line: 1 });
    assert.equal(mapLine(map, 2), null);
    assertRoundTrip(map);
  });

  test('empty non-landing files are skipped', () => {
    write('a.page', '[A -> /]');
    write('b.page', '\n \n');
    write('c.page', '[C -> /c]');
    const map = readPageFilesWithMap(dir);
    assert.deepEqual(map.files.map((f) => f.name), ['a.page', 'c.page']);
    assert.deepEqual(mapLine(map, 3), { file: 'c.page', line: 1 });
  });

  test('BOM is trimmed and does not shift lines', () => {
    write('landing.page', '\uFEFF[Home -> /]\nh1: Hi\n');
    const map = readPageFilesWithMap(dir);
    assert.equal(map.text, '[Home -> /]\nh1: Hi');
    assert.deepEqual(mapLine(map, 2), { file: 'landing.page', line: 2 });
  });

  test('BOM followed by blank lines counts the blank lines', () => {
    write('landing.page', '\uFEFF\n\n[Home -> /]\n');
    const map = readPageFilesWithMap(dir);
    assert.deepEqual(mapLine(map, 1), { file: 'landing.page', line: 3 });
  });

  test('separator lines and lines past the end map to null', () => {
    write('a.page', '[A -> /]\nh1: A');
    write('b.page', '[B -> /b]');
    const map = readPageFilesWithMap(dir);
    assert.equal(mapLine(map, 3), null);
    assert.deepEqual(mapLine(map, 4), { file: 'b.page', line: 1 });
    assert.equal(mapLine(map, 5), null);
    assert.equal(mapLine(map, 0), null);
  });

  test('CRLF files count only newlines', () => {
    write('landing.page', '\r\n[Home -> /]\r\n/// hero\r\nh1: Hi\r\n');
    write('z.page', '\r\n\r\n[Z -> /z]\r\nh1: Z\r\n');
    const map = readPageFilesWithMap(dir);
    assert.equal(map.text, '[Home -> /]\r\n/// hero\r\nh1: Hi\n\n[Z -> /z]\r\nh1: Z');
    assert.deepEqual(mapLine(map, 1), { file: 'landing.page', line: 2 });
    assert.deepEqual(mapLine(map, 6), { file: 'z.page', line: 4 });
    assertRoundTrip(map);
  });

  test('throws when there are no .page files', () => {
    assert.throws(() => readPageFilesWithMap(dir), /No \.page files found/);
  });
});
