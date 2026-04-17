'use strict';

const fs = require('fs');
const path = require('path');
const { fn, handleAuthError } = require('../supabase');
const { getProjectConfig } = require('../auth');
const { formatTable, formatDate, formatBytes } = require('../utils');

function safeAssetFilename(filename) {
  if (filename == null || typeof filename !== 'string') return null;
  const base = path.basename(String(filename).replace(/\\/g, '/'));
  if (!base || base === '.' || base === '..') return null;
  return base;
}

async function downloadFileBytes(fileId) {
  const urlData = await fn.invokeGet('get-file-url', { file_id: fileId });
  const fileUrl = urlData?.url;
  if (!fileUrl) throw new Error('No URL in response');
  const res = await fetch(fileUrl);
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return Buffer.from(await res.arrayBuffer());
}

/**
 * Sync remote project files to ./assets (1:1 with list-files: every row is written;
 * optional prune removes local files not present remotely).
 *
 * @returns {{ downloaded: number, removed: number, skipped: number, errors: { name: string, message: string }[], totalRemote: number }}
 */
async function syncAssets(cwd, options = {}) {
  const projectId = options.projectId ?? getProjectConfig(cwd)?.projectId;
  if (projectId == null) {
    const err = new Error(
      'Not in a project folder. Run from a folder with .micropage/project.json',
    );
    err.code = 'NO_PROJECT';
    throw err;
  }

  const data = await fn.invokeGet('list-files', { project_id: projectId });
  const files = data?.files || [];
  const assetsDir = path.join(cwd, 'assets');
  fs.mkdirSync(assetsDir, { recursive: true });

  const remoteBasenames = new Set();
  let downloaded = 0;
  let skipped = 0;
  const errors = [];
  const seenNames = new Set();

  for (const f of files) {
    const name = safeAssetFilename(f.filename);
    if (!name || f.id == null) {
      skipped += 1;
      continue;
    }
    if (seenNames.has(name) && !options.quiet) {
      console.warn(`Warning: duplicate filename in storage "${name}" — last row wins locally.`);
    }
    seenNames.add(name);
    remoteBasenames.add(name);
    try {
      const buf = await downloadFileBytes(f.id);
      fs.writeFileSync(path.join(assetsDir, name), buf);
      downloaded += 1;
      if (!options.quiet) console.log(`  ${name}`);
    } catch (e) {
      errors.push({ name, message: e.message || String(e) });
    }
  }

  let removed = 0;
  if (options.prune !== false && fs.existsSync(assetsDir)) {
    for (const e of fs.readdirSync(assetsDir, { withFileTypes: true })) {
      if (!e.isFile()) continue;
      if (!remoteBasenames.has(e.name)) {
        fs.unlinkSync(path.join(assetsDir, e.name));
        removed += 1;
      }
    }
  }

  return {
    downloaded,
    removed,
    skipped,
    errors,
    totalRemote: files.length,
  };
}

async function syncCli(options = {}) {
  const cwd = process.cwd();
  try {
    const r = await syncAssets(cwd, { quiet: options.quiet, prune: true });
    if (r.errors.length > 0) {
      for (const e of r.errors) {
        console.error(`Failed to download ${e.name}: ${e.message}`);
      }
      process.exit(1);
    }
    if (!options.quiet) {
      if (r.skipped > 0) {
        console.warn(`Skipped ${r.skipped} remote row(s) with missing id or filename.`);
      }
      const parts = [`${r.downloaded} file(s) match storage`];
      if (r.removed > 0) parts.push(`${r.removed} extra local file(s) removed`);
      console.log(parts.join('; ') + '.');
    }
  } catch (err) {
    handleAuthError(err);
    if (err.code === 'NO_PROJECT') console.error(err.message);
    else console.error('Sync failed:', err.message);
    process.exit(1);
  }
}

async function list(options = {}) {
  const cwd = process.cwd();
  const config = getProjectConfig(cwd);
  if (!config?.projectId) {
    console.error('Not in a project folder. Run from a folder with .micropage/project.json');
    process.exit(1);
  }

  let data;
  try {
    data = await fn.invokeGet('list-files', { project_id: config.projectId });
  } catch (err) {
    handleAuthError(err);
    console.error('Failed to list files:', err.message);
    process.exit(1);
  }

  const files = data?.files || [];
  if (files.length === 0) {
    console.log('No files uploaded for this project.');
    return;
  }

  if (options.json) {
    console.log(JSON.stringify(files, null, 2));
    return;
  }

  console.log(
    `Storage: ${formatBytes(data.total_bytes || 0)} / ${data.space_available_mb || 100} MB used\n`
  );

  const rows = files.map((f) => [
    f.filename || '-',
    f.mime_type || '-',
    formatBytes(f.size_bytes),
    formatDate(f.created_at),
  ]);
  formatTable(rows, ['Filename', 'Type', 'Size', 'Uploaded']);
}

async function url(filename, options = {}) {
  const cwd = process.cwd();
  const config = getProjectConfig(cwd);
  if (!config?.projectId) {
    console.error('Not in a project folder. Run from a folder with .micropage/project.json');
    process.exit(1);
  }

  // Find the file ID by listing files and matching filename
  let data;
  try {
    data = await fn.invokeGet('list-files', { project_id: config.projectId });
  } catch (err) {
    handleAuthError(err);
    console.error('Failed to list files:', err.message);
    process.exit(1);
  }

  const files = data?.files || [];
  const file = files.find((f) => f.filename === filename);
  if (!file) {
    console.error(`File not found: ${filename}`);
    process.exit(1);
  }

  let urlData;
  try {
    urlData = await fn.invokeGet('get-file-url', { file_id: file.id });
  } catch (err) {
    handleAuthError(err);
    console.error('Failed to get file URL:', err.message);
    process.exit(1);
  }

  const fileUrl = urlData?.url;
  if (!fileUrl) {
    console.error('Could not retrieve URL for this file.');
    process.exit(1);
  }

  console.log(fileUrl);

  if (options.copy) {
    try {
      const { execSync } = require('child_process');
      // Try xclip, xsel, wl-copy, pbcopy in order
      const cmds = ['xclip -selection clipboard', 'xsel --clipboard --input', 'wl-copy', 'pbcopy'];
      for (const cmd of cmds) {
        try {
          const [prog] = cmd.split(' ');
          execSync(`which ${prog}`, { stdio: 'ignore' });
          execSync(cmd, { input: fileUrl });
          console.log('URL copied to clipboard.');
          return;
        } catch {
          // try next
        }
      }
      console.log('(Could not copy to clipboard – copy manually above)');
    } catch {
      // ignore
    }
  }
}

module.exports = { list, url, syncAssets, sync: syncCli };
