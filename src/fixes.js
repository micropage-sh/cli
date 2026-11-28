'use strict';

/**
 * Turning parser fix suggestions into edits of the real .page files.
 *
 * The parser numbers lines in the merged text (see readPageFilesWithMap), and
 * a fix's `replace` is the new text of one merged line. The merged text is the
 * files trimmed and joined, so a file's first content line has lost its
 * leading whitespace (and BOM) and its last content line its trailing
 * whitespace; those are put back around the replacement so only what the
 * parser meant to change changes.
 */

const { mapLine } = require('./parser');
const { clean } = require('./diagnostics');

const MAX_REPLACE = 500;
// Tab is the only control character a .page line may legitimately contain.
// Bidi overrides are refused too: they would reorder what the user is shown.
const CONTROL = /[\u0000-\u0008\u000a-\u001f\u007f-\u009f\u2028\u2029\u202a-\u202e\u2066-\u2069]/;
const BOM = '\uFEFF';

function stripCr(s) {
  return s.endsWith('\r') ? s.slice(0, -1) : s;
}

function isValidFix(fix) {
  return (
    fix &&
    typeof fix === 'object' &&
    !Array.isArray(fix) &&
    Number.isInteger(fix.line) &&
    fix.line >= 1 &&
    typeof fix.replace === 'string' &&
    fix.replace.length <= MAX_REPLACE &&
    !fix.replace.includes('\n')
  );
}

/** A file's raw lines; `raw.split('\n')` keeps each line's `\r`. */
function rawLines(raw) {
  return raw.split('\n');
}

/**
 * Plan one edit per fixable diagnostic, in server order.
 *
 * `map` must come from readPageFilesWithMap(dir, { keepRaw: true }).
 * Returns `{ fixes, skipped }`. Each fix is
 *   { diagnostic, mergedLine, file, line, oldText, newText, oldRaw, newRaw }
 * where `line` is 1-based in `file`, `oldText`/`newText` are the line without
 * its outer whitespace, BOM or `\r` (for showing to the user), and
 * `oldRaw`/`newRaw` are the exact raw line before and after.
 * Each skipped entry is `{ diagnostic, file?, line?, reason }`.
 */
function planFixes(map, mergedText, diagnostics) {
  const fixes = [];
  const skipped = [];
  const claimed = new Set();
  const merged = String(mergedText ?? '').split('\n');
  const byName = new Map((map?.files || []).map((f) => [f.name, f]));

  for (const d of Array.isArray(diagnostics) ? diagnostics : []) {
    if (!d || typeof d !== 'object' || !isValidFix(d.fix)) continue;
    const mergedLine = d.fix.line;
    const at = mapLine(map, mergedLine);
    if (!at) {
      skipped.push({ diagnostic: d, reason: 'the suggested line is not in any .page file' });
      continue;
    }
    const where = { diagnostic: d, file: at.file, line: at.line };
    const newText = stripCr(d.fix.replace);
    if (CONTROL.test(newText)) {
      skipped.push({ ...where, reason: 'the suggestion contains control characters' });
      continue;
    }
    const mergedCore = stripCr(merged[mergedLine - 1] ?? '');
    if (newText === mergedCore) {
      skipped.push({ ...where, reason: 'the suggestion does not change the line' });
      continue;
    }
    if (claimed.has(mergedLine)) {
      skipped.push({ ...where, reason: 'another fix already changes this line' });
      continue;
    }

    const file = byName.get(at.file);
    if (file && file.utf8 === false) {
      skipped.push({ ...where, reason: `${clean(at.file)} is not UTF-8; nothing written to it` });
      continue;
    }
    const lines = typeof file?.raw === 'string' ? rawLines(file.raw) : null;
    const oldRaw = lines ? lines[at.line - 1] : undefined;
    if (typeof oldRaw !== 'string') {
      skipped.push({ ...where, reason: `${clean(at.file)} changed since the check` });
      continue;
    }

    const cr = oldRaw.endsWith('\r') ? '\r' : '';
    const bom = at.line === 1 && oldRaw.startsWith(BOM) ? BOM : '';
    const body = stripCr(bom ? oldRaw.slice(1) : oldRaw);
    const isFirst = at.line === file.leadingLines + 1;
    const isLast = at.line === file.leadingLines + file.lineCount;
    const prefix = isFirst ? body.match(/^\s*/)[0] : '';
    const rest = body.slice(prefix.length);
    const suffix = isLast ? rest.match(/\s*$/)[0] : '';
    const core = rest.slice(0, rest.length - suffix.length);
    if (core !== mergedCore) {
      skipped.push({ ...where, reason: `${clean(at.file)} changed since the check` });
      continue;
    }

    claimed.add(mergedLine);
    fixes.push({
      diagnostic: d,
      mergedLine,
      file: at.file,
      line: at.line,
      oldText: core,
      newText,
      oldRaw,
      newRaw: bom + prefix + newText + suffix + cr,
    });
  }

  return { fixes, skipped };
}

/**
 * Apply planned fixes for ONE file to its raw text. Every other byte (BOM,
 * line endings, final newline) is kept. Returns null when any fixed line no
 * longer matches what the check saw, so a stale file is never half-edited.
 */
function applyFixesToRaw(raw, fixes) {
  const lines = rawLines(String(raw));
  for (const f of fixes) {
    if (lines[f.line - 1] !== f.oldRaw) return null;
  }
  for (const f of fixes) lines[f.line - 1] = f.newRaw;
  return lines.join('\n');
}

// Names git can't take bare in a patch header (it would quote them), plus
// anything that would act on the terminal when the patch is shown.
const UNSAFE_PATCH_NAME = /[\u0000-\u001f\u007f-\u009f"\\\u2028\u2029\u202a-\u202e\u2066-\u2069]/;

function range(start, count) {
  return count === 1 ? `${start}` : `${start},${count}`;
}

/**
 * Render planned fixes as a unified diff (`git apply` / `patch -p1`), one
 * section per file in map order, with `context` lines around each change and
 * overlapping hunks merged as `diff -U` does. Files whose names can't appear
 * bare in a patch header are left out and reported through `onSkip(name)`.
 */
function renderUnifiedDiff(fixes, map, { context = 3, onSkip = () => {} } = {}) {
  const out = [];
  for (const file of map?.files || []) {
    const fileFixes = fixes.filter((f) => f.file === file.name).sort((a, b) => a.line - b.line);
    if (fileFixes.length === 0) continue;
    if (UNSAFE_PATCH_NAME.test(file.name)) {
      onSkip(file.name);
      continue;
    }

    const parts = rawLines(file.raw);
    const finalNewline = parts[parts.length - 1] === '';
    const lines = finalNewline ? parts.slice(0, -1) : parts;
    const last = lines.length - 1;
    const changed = new Map(fileFixes.map((f) => [f.line - 1, f]));

    const hunks = [];
    for (const f of fileFixes) {
      const i = f.line - 1;
      const start = Math.max(0, i - context);
      const end = Math.min(last, i + context);
      const prev = hunks[hunks.length - 1];
      if (prev && start <= prev.end + 1) prev.end = Math.max(prev.end, end);
      else hunks.push({ start, end });
    }

    out.push(`diff --git a/${file.name} b/${file.name}`, `--- a/${file.name}`, `+++ b/${file.name}`);
    const noNewline = (i) => (i === last && !finalNewline ? ['\\ No newline at end of file'] : []);
    for (const { start, end } of hunks) {
      const count = end - start + 1;
      out.push(`@@ -${range(start + 1, count)} +${range(start + 1, count)} @@`);
      let i = start;
      while (i <= end) {
        if (!changed.has(i)) {
          out.push(` ${lines[i]}`, ...noNewline(i));
          i++;
          continue;
        }
        const block = [];
        while (i <= end && changed.has(i)) block.push(i++);
        for (const j of block) out.push(`-${changed.get(j).oldRaw}`, ...noNewline(j));
        for (const j of block) out.push(`+${changed.get(j).newRaw}`, ...noNewline(j));
      }
    }
  }
  return out.length ? `${out.join('\n')}\n` : '';
}

module.exports = {
  planFixes,
  applyFixesToRaw,
  renderUnifiedDiff,
};
