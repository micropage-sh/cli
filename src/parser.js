const fs = require('fs');
const path = require('path');

/**
 * Read and merge .page files from a directory.
 *
 * Merge order:
 *   1. landing.page  (canonical primary file, if present)
 *   2. All other *.page files sorted lexicographically
 *
 * Files are joined with a single blank line separator.
 */
function readPageFilesFromDir(dir) {
  const entries = fs.readdirSync(dir, { withFileTypes: true });
  const primary = path.join(dir, 'landing.page');
  const others = [];

  for (const e of entries) {
    if (!e.isFile() || !e.name.endsWith('.page')) continue;
    if (e.name === 'landing.page') continue; // handled separately
    others.push(path.join(dir, e.name));
  }
  others.sort();

  const parts = [];
  if (fs.existsSync(primary)) {
    parts.push(fs.readFileSync(primary, 'utf8').trim());
  }
  for (const f of others) {
    const content = fs.readFileSync(f, 'utf8').trim();
    if (content) parts.push(content);
  }

  if (parts.length === 0) {
    throw new Error('No .page files found');
  }

  return parts.join('\n\n');
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
  writePageFile,
  listAssetsFromDir,
};
