'use strict';

/**
 * Asset resolution helpers for `micropage posts push`.
 *
 * Reuses the exact same asset pipeline the editor uses: `upload-file` (via
 * uploadAssetWithToken + hashFile + list-files dedup) to store the image, then
 * `get-file-url` to resolve its URL. Nothing here is CLI-specific — it mirrors
 * the editor's file-manager / image-picker flow.
 */

const fs = require('fs');
const path = require('path');

const { fn, hashFile, uploadAssetWithToken } = require('./supabase');

const IMAGE_EXTS = ['.png', '.jpg', '.jpeg', '.gif', '.webp', '.svg'];

function isAbsoluteUrl(s) {
  return typeof s === 'string' && /^https?:\/\//i.test(s.trim());
}

/**
 * Find a companion image next to a post file: `<postbasename>.<imgext>`,
 * e.g. `posts/2026-01-01-launch.md` -> `posts/2026-01-01-launch.png`.
 */
function findCompanionImage(postFilePath) {
  const dir = path.dirname(postFilePath);
  const base = path.basename(postFilePath, path.extname(postFilePath));
  for (const ext of IMAGE_EXTS) {
    const candidate = path.join(dir, `${base}${ext}`);
    if (fs.existsSync(candidate) && fs.statSync(candidate).isFile()) {
      return candidate;
    }
  }
  return null;
}

/**
 * Fetch the project's remote file list once and expose lookup-by-filename.
 * Callers should fetch this once per push and reuse it across posts.
 */
async function fetchRemoteFileIndex(projectId) {
  const data = await fn.invokeGet('list-files', { project_id: projectId });
  const files = data?.files || [];
  const byFilename = new Map();
  const byHash = new Map();
  for (const f of files) {
    if (f.filename) byFilename.set(f.filename, f);
    if (f.content_hash) byHash.set(f.content_hash, f);
  }
  return { byFilename, byHash };
}

/**
 * Resolve a `file_id` to its URL via the `get-file-url` edge function — the same
 * call the editor's image picker makes.
 */
async function fileUrlFor(fileId) {
  const data = await fn.invokeGet('get-file-url', { file_id: fileId });
  const url = data?.url;
  if (!url) throw new Error(`get-file-url returned no url for file_id=${fileId}`);
  return url;
}

/**
 * Upload a local file if its content hash isn't already present remotely
 * (dedup, mirrors uploadAssetsWithToken), then resolve its absolute URL.
 * Mutates `fileIndex` in place so repeated calls within the same push reuse it.
 */
async function uploadLocalImageOnce(accessToken, projectId, filePath, fileIndex) {
  const filename = path.basename(filePath);
  const localHash = hashFile(filePath);

  const existingByHash = fileIndex.byHash.get(localHash);
  if (existingByHash) {
    return { fileId: existingByHash.id, uploaded: false, filename: existingByHash.filename };
  }

  const uploadResult = await uploadAssetWithToken(accessToken, projectId, filePath, filename);
  const file = uploadResult?.file;
  if (!file?.id) throw new Error(`upload-file returned no file record for ${filename}`);

  fileIndex.byFilename.set(file.filename, file);
  if (file.content_hash) fileIndex.byHash.set(file.content_hash, file);

  return { fileId: file.id, uploaded: true, filename: file.filename };
}

/**
 * Resolve a post's hero image to an absolute URL.
 *
 * Priority: companion file next to the .md > front-matter `hero:` > none.
 * `hero:` may be:
 *   - an absolute http(s) URL (passthrough, no upload)
 *   - a local file path (relative to the post file, or to assets/) that exists on disk (upload)
 *   - an existing uploaded asset filename (resolve via list-files, no upload)
 *
 * @returns {Promise<{ url: string|null, uploaded: boolean, source: string|null }>}
 */
async function resolveHeroImage({ accessToken, projectId, postFilePath, cwd, heroFrontMatter, fileIndex }) {
  const companion = findCompanionImage(postFilePath);
  if (companion) {
    const { fileId, uploaded, filename } = await uploadLocalImageOnce(accessToken, projectId, companion, fileIndex);
    const url = await fileUrlFor(fileId);
    return { url, uploaded, source: `companion:${filename}` };
  }

  const hero = typeof heroFrontMatter === 'string' ? heroFrontMatter.trim() : '';
  if (!hero) return { url: null, uploaded: false, source: null };

  if (isAbsoluteUrl(hero)) {
    return { url: hero, uploaded: false, source: 'url' };
  }

  // Local file path: relative to the post file's directory, then to assets/, then to cwd.
  const candidates = [
    path.isAbsolute(hero) ? hero : path.join(path.dirname(postFilePath), hero),
    path.join(cwd, 'assets', hero),
    path.join(cwd, hero),
  ];
  const localPath = candidates.find((p) => fs.existsSync(p) && fs.statSync(p).isFile());
  if (localPath) {
    const { fileId, uploaded, filename } = await uploadLocalImageOnce(accessToken, projectId, localPath, fileIndex);
    const url = await fileUrlFor(fileId);
    return { url, uploaded, source: `local:${filename}` };
  }

  // Existing uploaded asset, referenced by filename only.
  const existing = fileIndex.byFilename.get(hero) || fileIndex.byFilename.get(path.basename(hero));
  if (existing) {
    const url = await fileUrlFor(existing.id);
    return { url, uploaded: false, source: `existing:${existing.filename}` };
  }

  throw new Error(`hero image not found: "${hero}" (not a URL, local file, or existing uploaded asset)`);
}

// Matches markdown image refs: ![alt](path "title"). Captures alt and the path only.
const MD_IMAGE_RE = /!\[([^\]]*)\]\(\s*([^)\s]+)(?:\s+"[^"]*")?\s*\)/g;

/**
 * Scan `body_markdown` for local image refs (`![alt](rel/path.png)`), upload each
 * once (hash-dedup via `fileIndex`), and rewrite the markdown to use hosted
 * absolute URLs. Absolute URLs and refs that don't resolve to a local file are
 * left untouched.
 *
 * Refs that look local (relative, not a URL / root-absolute / anchor) but don't
 * resolve to a file on disk are reported in `unresolved` so the caller can warn —
 * otherwise a typo'd path would ship into body_markdown and 404 on the live page.
 *
 * @returns {Promise<{ markdown: string, uploaded: string[], mapping: Record<string,string>, unresolved: string[] }>}
 */
async function resolveBodyImages({ accessToken, projectId, postFilePath, cwd, body, fileIndex }) {
  const refs = [];
  let match;
  MD_IMAGE_RE.lastIndex = 0;
  while ((match = MD_IMAGE_RE.exec(body)) !== null) {
    refs.push(match[2]);
  }

  const mapping = {};
  const uploaded = [];
  const unresolved = [];

  for (const ref of refs) {
    if (mapping[ref] || isAbsoluteUrl(ref) || ref.startsWith('/') || ref.startsWith('#')) continue;

    const candidates = [
      path.join(path.dirname(postFilePath), ref),
      path.join(cwd, 'assets', ref),
      path.join(cwd, ref),
    ];
    const localPath = candidates.find((p) => fs.existsSync(p) && fs.statSync(p).isFile());
    if (!localPath) {
      // Looks like a local ref but no file on disk — surface it, don't ship it silently.
      if (!unresolved.includes(ref)) unresolved.push(ref);
      continue;
    }

    const { fileId, uploaded: wasUploaded, filename } = await uploadLocalImageOnce(
      accessToken,
      projectId,
      localPath,
      fileIndex,
    );
    const url = await fileUrlFor(fileId);
    mapping[ref] = url;
    if (wasUploaded) uploaded.push(filename);
  }

  if (Object.keys(mapping).length === 0) {
    return { markdown: body, uploaded, mapping, unresolved };
  }

  MD_IMAGE_RE.lastIndex = 0;
  const rewritten = body.replace(MD_IMAGE_RE, (full, alt, ref) => {
    const resolved = mapping[ref];
    return resolved ? `![${alt}](${resolved})` : full;
  });

  return { markdown: rewritten, uploaded, mapping, unresolved };
}

module.exports = {
  findCompanionImage,
  fetchRemoteFileIndex,
  fileUrlFor,
  resolveHeroImage,
  resolveBodyImages,
};
