const fs = require('fs');
const path = require('path');

/**
 * True when `bytes` is UTF-8 text that decodes and re-encodes unchanged (a
 * BOM is fine). Invalid sequences would come back as U+FFFD, and NUL bytes
 * mean UTF-16 or binary; rewriting either from the decoded string would
 * damage lines nobody asked to change.
 */
function isUtf8Text(bytes) {
  if (bytes.includes(0)) return false;
  return Buffer.from(bytes.toString('utf8'), 'utf8').equals(bytes);
}

function countNewlines(s) {
  let n = 0;
  for (let i = s.indexOf('\n'); i !== -1; i = s.indexOf('\n', i + 1)) n++;
  return n;
}

/**
 * Read and merge .page files from a directory, keeping a map from lines of the
 * merged text back to the file they came from.
 *
 * Merge order:
 *   1. landing.page  (canonical primary file, if present, kept even when empty)
 *   2. All other non-empty *.page files sorted lexicographically
 *
 * Each file is trimmed and files are joined with a single blank line separator.
 *
 * Returns `{ text, files }`, where each file entry is
 * `{ name, startLine, lineCount, leadingLines }`: `startLine` is the 1-based
 * line in `text` where the file's trimmed content starts, `lineCount` how many
 * lines it spans there, and `leadingLines` how many lines `trim()` removed from
 * the top of the file. With `keepRaw`, each entry also carries `raw`, the
 * file's untrimmed text, `bytes`, the file as read, and `utf8`, whether those
 * bytes survive decoding (see isUtf8Text), so fixes are only ever written
 * back to files that round-trip byte for byte.
 */
function readPageFilesWithMap(dir, { keepRaw = false } = {}) {
  const entries = fs.readdirSync(dir, { withFileTypes: true });
  const primary = path.join(dir, 'landing.page');
  const others = [];

  for (const e of entries) {
    if (!e.isFile() || !e.name.endsWith('.page')) continue;
    if (e.name === 'landing.page') continue; // handled separately
    others.push(path.join(dir, e.name));
  }
  others.sort();

  const sources = [];
  if (fs.existsSync(primary)) sources.push({ file: primary, keepEmpty: true });
  for (const f of others) sources.push({ file: f, keepEmpty: false });

  const parts = [];
  const files = [];
  let startLine = 1;
  for (const { file, keepEmpty } of sources) {
    const bytes = fs.readFileSync(file);
    const raw = bytes.toString('utf8');
    const content = raw.trim();
    if (!content && !keepEmpty) continue;
    const lineCount = countNewlines(content) + 1;
    const leadingLines = content ? countNewlines(raw.slice(0, raw.length - raw.trimStart().length)) : 0;
    parts.push(content);
    const entry = { name: path.basename(file), startLine, lineCount, leadingLines };
    if (keepRaw) Object.assign(entry, { raw, bytes, utf8: isUtf8Text(bytes) });
    files.push(entry);
    // +1 for the blank separator line the join inserts.
    startLine += lineCount + 1;
  }

  if (parts.length === 0) {
    throw new Error('No .page files found');
  }

  return { text: parts.join('\n\n'), files };
}

function readPageFilesFromDir(dir) {
  return readPageFilesWithMap(dir).text;
}

/**
 * Map a 1-based line of the merged text to `{ file, line }` in the source file.
 * Returns null for the blank separator lines and lines past the end.
 */
function mapLine(map, line) {
  if (!map || !Array.isArray(map.files) || !Number.isInteger(line)) return null;
  for (const f of map.files) {
    if (line >= f.startLine && line < f.startLine + f.lineCount) {
      return { file: f.name, line: line - f.startLine + 1 + f.leadingLines };
    }
  }
  return null;
}

/**
 * Write raw content to landing.page in the given directory.
 * Used by `micropage pull` to save the latest build content locally.
 */
function writePageFile(dir, content) {
  const dest = path.join(dir, 'landing.page');
  fs.writeFileSync(dest, content, 'utf8');
  return dest;
}

/**
 * Read a root-level llms.txt from the given directory.
 *
 * Returns the file's UTF-8 content verbatim, or null if the file is absent or
 * whitespace-only. Content is preserved as-is so authors control the served
 * `/llms.txt` exactly (only a trailing newline is dropped).
 */
function readLlmsTxtFromDir(dir) {
  const file = path.join(dir, 'llms.txt');
  if (!fs.existsSync(file)) return null;
  const content = fs.readFileSync(file, 'utf8');
  if (!content.trim()) return null;
  return content.replace(/\n$/, '');
}

function listAssetsFromDir(dir) {
  const assetsDir = path.join(dir, 'assets');
  if (!fs.existsSync(assetsDir)) return [];
  const entries = fs.readdirSync(assetsDir, { withFileTypes: true });
  const files = [];
  for (const e of entries) {
    if (!e.isFile()) continue;
    if (e.name.startsWith('.')) continue;
    files.push(e.name);
  }
  return files.sort();
}

module.exports = {
  readPageFilesFromDir,
  readPageFilesWithMap,
  isUtf8Text,
  mapLine,
  writePageFile,
  listAssetsFromDir,
  readLlmsTxtFromDir,
};
