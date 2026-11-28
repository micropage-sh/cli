'use strict';

const { mapLine } = require('./parser');

const SEVERITIES = ['error', 'warning', 'hint'];

/**
 * Detach `diagnostics` from a /parse response so it never reaches
 * builds.json_content. `diagnostics` is null when the parser did not send the
 * key (an older build compiler), which is not an error.
 */
function splitParseResponse(json) {
  if (!json || typeof json !== 'object' || Array.isArray(json)) {
    return { json, diagnostics: null };
  }
  if (!Object.prototype.hasOwnProperty.call(json, 'diagnostics')) {
    return { json, diagnostics: null };
  }
  const { diagnostics, ...rest } = json;
  const list = Array.isArray(diagnostics)
    ? diagnostics.filter((d) => d && typeof d === 'object' && !Array.isArray(d))
    : null;
  return { json: rest, diagnostics: list };
}

function normalizeSeverity(severity) {
  return SEVERITIES.includes(severity) ? severity : 'hint';
}

// Author text is echoed back in messages and fixes; keep terminal control
// sequences in it from reaching the user's terminal.
function clean(value) {
  return String(value ?? '').replace(/\r/g, '').replace(/[\u0000-\u0008\u000a-\u001f\u007f-\u009f\u2028\u2029\u202a-\u202e\u2066-\u2069]/g, '?');
}

function location(line, column, map) {
  const col = Number.isInteger(column) && column > 0 ? column : 1;
  const mapped = mapLine(map, line);
  if (mapped) return `${clean(mapped.file)}:${mapped.line}:${col}`;
  return `<merged>:${line}:${col}`;
}

/**
 * gcc-style rendering of one diagnostic, e.g.
 *   landing.page:14:1: warning: Image has no alt text [missing-alt]
 *     suggested: p: Prices <- not down
 */
function formatDiagnostic(d, map) {
  const severity = normalizeSeverity(d.severity);
  const hasLine = Number.isInteger(d.line) && d.line > 0;
  const prefix = hasLine ? location(d.line, d.column, map) : 'micropage';
  const code = d.code ? ` [${clean(d.code)}]` : '';
  const lines = [`${prefix}: ${severity}: ${clean(d.message)}${code}`];

  const fix = d.fix;
  if (fix && typeof fix === 'object' && Number.isInteger(fix.line) && typeof fix.replace === 'string') {
    const where = fix.line === d.line ? '' : ` (${location(fix.line, 1, map).replace(/:1$/, '')})`;
    lines.push(`  suggested${where}: ${clean(fix.replace)}`);
  }
  return lines.join('\n');
}

function plural(n, word) {
  return `${n} ${word}${n === 1 ? '' : 's'}`;
}

/** One-line count summary, or '' when there is nothing to report. */
function summarize(diagnostics, source = 'Parser') {
  if (!Array.isArray(diagnostics) || diagnostics.length === 0) return '';
  const counts = { error: 0, warning: 0, hint: 0 };
  let truncated = false;
  for (const d of diagnostics) {
    if (d.code === 'too-many-diagnostics') {
      truncated = true;
      continue;
    }
    counts[normalizeSeverity(d.severity)]++;
  }
  const parts = [];
  if (counts.error) parts.push(plural(counts.error, 'error'));
  if (counts.warning) parts.push(plural(counts.warning, 'warning'));
  if (counts.hint) parts.push(plural(counts.hint, 'hint'));
  if (parts.length === 0 && !truncated) return '';
  return `${source} reported ${parts.join(', ') || 'diagnostics'}${truncated ? ' (more not shown)' : ''}.`;
}

/** Diagnostics that fail --strict: errors and warnings; hints never fail. */
function strictFailures(diagnostics) {
  if (!Array.isArray(diagnostics)) return [];
  return diagnostics.filter((d) => {
    const s = normalizeSeverity(d.severity);
    return s === 'error' || s === 'warning';
  });
}

function strictFailureMessage(failures) {
  const errors = failures.filter((d) => normalizeSeverity(d.severity) === 'error').length;
  const warnings = failures.length - errors;
  const parts = [];
  if (errors) parts.push(plural(errors, 'error'));
  if (warnings) parts.push(plural(warnings, 'warning'));
  return `Build not saved: --strict found ${parts.join(' and ')}.`;
}

/**
 * Print diagnostics to stderr, mapped to source files. Returns the diagnostics
 * that fail --strict (always [] when not strict or when the parser sent none).
 */
function reportDiagnostics(diagnostics, map, { strict = false, log = (...a) => console.error(...a) } = {}) {
  if (diagnostics == null) {
    if (strict) log('micropage: note: diagnostics unavailable from the parser; --strict could not check this build.');
    return [];
  }
  // Reporting must never break a push: a formatting bug on odd server output
  // would otherwise leave a half-created draft behind.
  try {
    for (const d of diagnostics) log(formatDiagnostic(d, map));
    const summary = summarize(diagnostics);
    if (summary) log(summary);
  } catch (err) {
    log(`micropage: note: could not print parser diagnostics (${err.message}).`);
  }
  return strict ? strictFailures(diagnostics) : [];
}

// The server caps at 50 plus one truncation note; a misbehaving server must
// not flood the terminal either.
const MAX_POST_DIAGNOSTICS = 51;

/**
 * Print upsert-post diagnostics for one saved post to stderr. Lines arrive
 * relative to body_markdown; `lineOffset` is the number of file lines before
 * the body, so `file` lines match what an editor shows. A response without
 * `diagnostics` (an older server) prints nothing. Never throws.
 */
function reportPostDiagnostics(diagnostics, { file, lineOffset = 0, log = (...a) => console.error(...a) } = {}) {
  if (!Array.isArray(diagnostics)) return;
  try {
    const list = diagnostics
      .filter((d) => d && typeof d === 'object' && !Array.isArray(d))
      .slice(0, MAX_POST_DIAGNOSTICS);
    if (list.length === 0) return;
    const offset = Number.isInteger(lineOffset) && lineOffset > 0 ? lineOffset : 0;
    const map = { files: [{ name: clean(file), startLine: 1, lineCount: Infinity, leadingLines: offset }] };
    for (const d of list) {
      const entry = { ...d, message: String(d.message ?? '').slice(0, 300) };
      const text = formatDiagnostic(entry, map);
      const hasLine = Number.isInteger(d.line) && d.line > 0;
      // A whole-post note names the post, not "micropage".
      log(hasLine ? text : text.replace(/^micropage: /, `${clean(file)}: `));
    }
    const summary = summarize(list, 'Post check');
    if (summary) log(summary);
  } catch (err) {
    log(`micropage: note: could not print post diagnostics (${err.message}).`);
  }
}

// The server caps at 50 plus one truncation note.
const MAX_DIAGNOSTICS = 51;

const isLine = (v) => Number.isInteger(v) && v >= 1;

/**
 * Diagnostics with merged-text lines translated to file lines, in the shape
 * the MCP server returns: `{file?, line?, column?, severity, code, message,
 * fix?: {file, line, replace}}`. Malformed entries are dropped and a fix that
 * maps to no file line is left out, since it could land in the wrong file.
 */
function mapDiagnostics(diagnostics, map) {
  const out = [];
  for (const d of Array.isArray(diagnostics) ? diagnostics : []) {
    if (out.length >= MAX_DIAGNOSTICS) break;
    if (!d || typeof d !== 'object' || Array.isArray(d)) continue;
    if (typeof d.code !== 'string' || typeof d.message !== 'string') continue;
    const m = {};
    if (isLine(d.line)) {
      const at = mapLine(map, d.line);
      if (at) m.file = at.file;
      m.line = at ? at.line : d.line;
      if (isLine(d.column)) m.column = d.column;
    }
    m.severity = normalizeSeverity(d.severity);
    m.code = d.code.slice(0, 100);
    m.message = d.message.slice(0, 300);
    const fix = d.fix;
    if (fix && typeof fix === 'object' && !Array.isArray(fix)
      && isLine(fix.line) && typeof fix.replace === 'string'
      && fix.replace.length <= 500 && !fix.replace.includes('\n')) {
      const at = mapLine(map, fix.line);
      if (at) m.fix = { file: at.file, line: at.line, replace: fix.replace };
    }
    out.push(m);
  }
  return out;
}

/** Severity counts, leaving out the "more not shown" note. */
function countDiagnostics(diagnostics) {
  const counts = { error: 0, warning: 0, hint: 0 };
  for (const d of Array.isArray(diagnostics) ? diagnostics : []) {
    if (!d || d.code === 'too-many-diagnostics') continue;
    counts[normalizeSeverity(d.severity)]++;
  }
  return counts;
}

function isTruncated(diagnostics) {
  return Array.isArray(diagnostics) && diagnostics.some((d) => d && d.code === 'too-many-diagnostics');
}

class StrictDiagnosticsError extends Error {
  constructor(failures) {
    super(strictFailureMessage(failures));
    this.name = 'StrictDiagnosticsError';
    this.code = 'STRICT_DIAGNOSTICS';
    this.failures = failures;
  }
}

module.exports = {
  splitParseResponse,
  normalizeSeverity,
  formatDiagnostic,
  summarize,
  strictFailures,
  strictFailureMessage,
  reportDiagnostics,
  reportPostDiagnostics,
  mapDiagnostics,
  countDiagnostics,
  isTruncated,
  clean,
  MAX_DIAGNOSTICS,
  StrictDiagnosticsError,
};
