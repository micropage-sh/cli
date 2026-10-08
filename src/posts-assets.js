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

// Accessed through the module object (not destructured) so tests can stub calls.
const supabase = require('./supabase');

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
  const data = await supabase.fn.invokeGet('list-files', { project_id: projectId });
  const files = data?.files || [];
  const byFilename = new Map();
  const byHash = new Map();
  for (const f of files) {
    if (f.filename) byFilename.set(f.filename, f);
    if (f.content_hash) byHash.set(f.content_hash, f);
  }
  return { byFilename, byHash, urlById: new Map() };
}

/**
 * Resolve a `file_id` to its URL via the `get-file-url` edge function — the same
 * call the editor's image picker makes. Memoized on `fileIndex` when given, since
 * a push resolves every image twice when it has something to upload.
 */
async function fileUrlFor(fileId, fileIndex = null) {
  const cache = fileIndex?.urlById;
  if (cache && cache.has(fileId)) return cache.get(fileId);
  const data = await supabase.fn.invokeGet('get-file-url', { file_id: fileId });
  const url = data?.url;
  if (!url) throw new Error(`get-file-url returned no url for file_id=${fileId}`);
  if (cache) cache.set(fileId, url);
  return url;
}

// Stand-in URL for an image that lookup mode found locally but that isn't
// uploaded yet; it never equals a stored URL, so the post reads as changed.
function pendingUploadUrl(hash) {
  return `pending-upload:${hash}`;
}

/**
 * Upload a local file if its content hash isn't already present remotely
 * (dedup, mirrors uploadAssetsWithToken), then resolve its absolute URL.
 * Mutates `fileIndex` in place so repeated calls within the same push reuse it.
 * With `upload: false` nothing is uploaded; a missing file comes back as
 * `{ fileId: null, pending: true }`.
 */
async function uploadLocalImageOnce(accessToken, projectId, filePath, fileIndex, upload = true) {
  const filename = path.basename(filePath);
  const localHash = supabase.hashFile(filePath);

  const existingByHash = fileIndex.byHash.get(localHash);
  if (existingByHash) {
    return { fileId: existingByHash.id, uploaded: false, filename: existingByHash.filename };
  }

  if (!upload) return { fileId: null, uploaded: false, pending: true, hash: localHash, filename };

  const uploadResult = await supabase.uploadAssetWithToken(accessToken, projectId, filePath, filename);
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
 * With `upload: false` (lookup mode) a local image that isn't uploaded yet is
 * not uploaded: it is listed in `pendingUploads` and `url` is a placeholder.
 *
 * @returns {Promise<{ url: string|null, uploaded: boolean, source: string|null, pendingUploads: string[] }>}
 */
async function resolveHeroImage({ accessToken, projectId, postFilePath, cwd, heroFrontMatter, fileIndex, upload = true }) {
  const resolveLocal = async (localPath, kind) => {
    const r = await uploadLocalImageOnce(accessToken, projectId, localPath, fileIndex, upload);
    if (r.pending) {
      return { url: pendingUploadUrl(r.hash), uploaded: false, source: `${kind}:${r.filename}`, pendingUploads: [r.filename] };
    }
    const url = await fileUrlFor(r.fileId, fileIndex);
    return { url, uploaded: r.uploaded, source: `${kind}:${r.filename}`, pendingUploads: [] };
  };

  const companion = findCompanionImage(postFilePath);
  if (companion) return resolveLocal(companion, 'companion');

  const hero = typeof heroFrontMatter === 'string' ? heroFrontMatter.trim() : '';
  if (!hero) return { url: null, uploaded: false, source: null, pendingUploads: [] };

  if (isAbsoluteUrl(hero)) {
    return { url: hero, uploaded: false, source: 'url', pendingUploads: [] };
  }

  // Local file path: relative to the post file's directory, then to assets/, then to cwd.
  const candidates = [
    path.isAbsolute(hero) ? hero : path.join(path.dirname(postFilePath), hero),
    path.join(cwd, 'assets', hero),
    path.join(cwd, hero),
  ];
  const localPath = candidates.find((p) => fs.existsSync(p) && fs.statSync(p).isFile());
  if (localPath) return resolveLocal(localPath, 'local');

  // Existing uploaded asset, referenced by filename only.
  const existing = fileIndex.byFilename.get(hero) || fileIndex.byFilename.get(path.basename(hero));
  if (existing) {
    const url = await fileUrlFor(existing.id, fileIndex);
    return { url, uploaded: false, source: `existing:${existing.filename}`, pendingUploads: [] };
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
 * With `upload: false` (lookup mode) images not uploaded yet are listed in
 * `pendingUploads` and rewritten to a placeholder instead of being uploaded.
 *
 * @returns {Promise<{ markdown: string, uploaded: string[], mapping: Record<string,string>, unresolved: string[], pendingUploads: string[] }>}
 */
async function resolveBodyImages({ accessToken, projectId, postFilePath, cwd, body, fileIndex, upload = true }) {
  const refs = [];
  let match;
  MD_IMAGE_RE.lastIndex = 0;
  while ((match = MD_IMAGE_RE.exec(body)) !== null) {
    refs.push(match[2]);
  }

  const mapping = {};
  const uploaded = [];
  const unresolved = [];
  const pendingUploads = [];

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

    const { fileId, uploaded: wasUploaded, filename, pending, hash } = await uploadLocalImageOnce(
      accessToken,
      projectId,
      localPath,
      fileIndex,
      upload,
    );
    if (pending) {
      mapping[ref] = pendingUploadUrl(hash);
      if (!pendingUploads.includes(filename)) pendingUploads.push(filename);
      continue;
    }
    const url = await fileUrlFor(fileId, fileIndex);
    mapping[ref] = url;
    if (wasUploaded) uploaded.push(filename);
  }

  if (Object.keys(mapping).length === 0) {
    return { markdown: body, uploaded, mapping, unresolved, pendingUploads };
  }

  MD_IMAGE_RE.lastIndex = 0;
  const rewritten = body.replace(MD_IMAGE_RE, (full, alt, ref) => {
    const resolved = mapping[ref];
    return resolved ? `![${alt}](${resolved})` : full;
  });

  return { markdown: rewritten, uploaded, mapping, unresolved, pendingUploads };
}

module.exports = {
  findCompanionImage,
  fetchRemoteFileIndex,
  fileUrlFor,
  resolveHeroImage,
  resolveBodyImages,
};
