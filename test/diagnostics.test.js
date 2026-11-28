'use strict';
/**
 * Unit tests for cli/src/diagnostics.js: /parse response splitting, gcc-style
 * formatting against a merged-file line map, and the --strict rule.
 */

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');

const {
  splitParseResponse,
  formatDiagnostic,
  summarize,
  strictFailures,
  strictFailureMessage,
  reportDiagnostics,
} = require('../src/diagnostics');

// landing.page lines 1-3 at merged 1-3, separator at 4, about.page (2 leading
// blank lines trimmed) at merged 5-6.
const map = {
  text: '',
  files: [
    { name: 'landing.page', startLine: 1, lineCount: 3, leadingLines: 0 },
    { name: 'about.page', startLine: 5, lineCount: 2, leadingLines: 2 },
  ],
};

describe('splitParseResponse', () => {
  test('detaches diagnostics from the json', () => {
    const diag = [{ severity: 'warning', code: 'missing-alt', message: 'm', line: 2 }];
    const { json, diagnostics } = splitParseResponse({ site: {}, pages: [], manifest: {}, diagnostics: diag });
    assert.deepEqual(json, { site: {}, pages: [], manifest: {} });
    assert.equal(Object.prototype.hasOwnProperty.call(json, 'diagnostics'), false);
    assert.deepEqual(diagnostics, diag);
  });

  test('missing key (older parser) gives null and leaves json untouched', () => {
    const input = { pages: [] };
    const { json, diagnostics } = splitParseResponse(input);
    assert.equal(json, input);
    assert.equal(diagnostics, null);
  });

  test('empty array stays an empty array', () => {
    assert.deepEqual(splitParseResponse({ pages: [], diagnostics: [] }).diagnostics, []);
  });

  test('non-array diagnostics is detached and treated as unavailable', () => {
    const { json, diagnostics } = splitParseResponse({ pages: [], diagnostics: 'x' });
    assert.deepEqual(json, { pages: [] });
    assert.equal(diagnostics, null);
  });

  test('non-object entries are dropped', () => {
    const { diagnostics } = splitParseResponse({ diagnostics: [null, 3, { severity: 'hint', code: 'c', message: 'm' }] });
    assert.equal(diagnostics.length, 1);
  });
});

describe('formatDiagnostic', () => {
  test('maps the merged line to file:line:column', () => {
    const out = formatDiagnostic(
      { line: 2, column: 3, severity: 'warning', code: 'missing-alt', message: 'Image has no alt text' },
      map,
    );
    assert.equal(out, 'landing.page:2:3: warning: Image has no alt text [missing-alt]');
  });

  test('second file accounts for trimmed leading lines; column defaults to 1', () => {
    const out = formatDiagnostic({ line: 6, severity: 'error', code: 'dropped-block', message: 'm' }, map);
    assert.equal(out, 'about.page:4:1: error: m [dropped-block]');
  });

  test('fix is printed as a suggestion line', () => {
    const out = formatDiagnostic(
      {
        line: 5,
        column: 1,
        severity: 'hint',
        code: 'unknown-tag',
        message: 'Unknown tag "buton:"; did you mean "button:"?',
        fix: { line: 5, replace: 'button: Go -> /x' },
      },
      map,
    );
    assert.equal(
      out,
      'about.page:3:1: hint: Unknown tag "buton:"; did you mean "button:"? [unknown-tag]\n' +
        '  suggested: button: Go -> /x',
    );
  });

  test('fix on a different line names that line', () => {
    const out = formatDiagnostic(
      { line: 2, severity: 'error', code: 'c', message: 'm', fix: { line: 3, replace: ' [x]' } },
      map,
    );
    assert.match(out, /\n {2}suggested \(landing\.page:3\):  \[x\]$/);
  });

  test('no line uses the micropage: prefix', () => {
    const out = formatDiagnostic({ severity: 'hint', code: 'too-many-diagnostics', message: '7 more not shown' }, map);
    assert.equal(out, 'micropage: hint: 7 more not shown [too-many-diagnostics]');
  });

  test('unmapped line falls back to the merged line number', () => {
    const out = formatDiagnostic({ line: 4, severity: 'warning', code: 'c', message: 'm' }, map);
    assert.equal(out, '<merged>:4:1: warning: m [c]');
  });

  test('unknown severity is shown as hint', () => {
    const out = formatDiagnostic({ line: 1, severity: 'fatal', code: 'c', message: 'm' }, map);
    assert.equal(out, 'landing.page:1:1: hint: m [c]');
  });

  test('control characters in author text are neutralised', () => {
    const out = formatDiagnostic({ line: 1, severity: 'warning', code: 'c', message: 'a\u001b[31mb\r' }, map);
    assert.equal(out, 'landing.page:1:1: warning: a?[31mb [c]');
  });
});

describe('strict and summary', () => {
  const diags = [
    { line: 1, severity: 'error', code: 'a', message: 'm' },
    { line: 2, severity: 'warning', code: 'b', message: 'm' },
    { line: 3, severity: 'hint', code: 'c', message: 'm' },
    { line: 3, severity: 'mystery', code: 'd', message: 'm' },
  ];

  test('strictFailures keeps errors and warnings; unknown severities are hints', () => {
    assert.deepEqual(strictFailures(diags).map((d) => d.code), ['a', 'b']);
    assert.deepEqual(strictFailures([{ severity: 'hint' }]), []);
    assert.deepEqual(strictFailures(null), []);
  });

  test('strictFailureMessage counts', () => {
    assert.equal(strictFailureMessage(strictFailures(diags)), 'Build not saved: --strict found 1 error and 1 warning.');
  });

  test('summarize', () => {
    assert.equal(summarize(diags), 'Parser reported 1 error, 1 warning, 2 hints.');
    assert.equal(summarize([]), '');
    assert.equal(summarize(null), '');
    assert.equal(
      summarize([{ severity: 'warning' }, { severity: 'hint', code: 'too-many-diagnostics', message: 'x' }]),
      'Parser reported 1 warning (more not shown).',
    );
  });

  test('reportDiagnostics prints each entry and a summary; returns failures only when strict', () => {
    const out = [];
    const log = (l) => out.push(l);
    assert.deepEqual(reportDiagnostics(diags, map, { log }), []);
    assert.equal(out.length, 5);
    assert.equal(out[4], 'Parser reported 1 error, 1 warning, 2 hints.');
    assert.equal(reportDiagnostics(diags, map, { strict: true, log: () => {} }).length, 2);
  });

  test('reportDiagnostics with no diagnostics key: silent normally, a note under --strict', () => {
    const out = [];
    const log = (l) => out.push(l);
    assert.deepEqual(reportDiagnostics(null, map, { log }), []);
    assert.equal(out.length, 0);
    assert.deepEqual(reportDiagnostics(null, map, { strict: true, log }), []);
    assert.match(out[0], /diagnostics unavailable/);
  });
});

describe('reportDiagnostics robustness', () => {
  test('never throws when formatting fails, and still returns strict failures', () => {
    const bad = { line: 1, severity: 'warning', code: 'x', get message() { throw new Error('boom'); } };
    const logged = [];
    const failures = reportDiagnostics([bad], null, { strict: true, log: (m) => logged.push(m) });
    assert.equal(failures.length, 1);
    assert.match(logged.at(-1), /could not print parser diagnostics \(boom\)/);
  });
});
