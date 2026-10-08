'use strict';

/**
 * Change detection for `micropage posts push` / `pull`. Pure helpers plus the
 * sync-state file; nothing here talks to the network.
 *
 * posts.updated_at can't tell whether a post was edited since the last push
 * (the server only bumps it for content edits of published posts), so the CLI
 * keeps its own baseline in .micropage/posts-sync.json: per post id, a hash of
 * the remote row as last synced and per-field hashes of the local file as last
 * synced.
 */

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const SYNC_STATE_FILE = path.join('.micropage', 'posts-sync.json');
const SYNC_STATE_VERSION = 1;

// Order matters: it is part of the remote hash.
const SYNC_FIELDS = [
  'title',
  'body_markdown',
  'description',
  'hero_image',
  'web_visibility',
  'form_id',
  'email_enabled',
  'subject',
  'preheader',
];

const FIELD_LABELS = {
  title: 'title',
  body_markdown: 'body',
  description: 'description',
  hero_image: 'hero',
  web_visibility: 'visibility',
  form_id: 'list',
  email_enabled: 'email',
  subject: 'subject',
  preheader: 'preview',
  date: 'date',
};

const DATE_ONLY_RE = /^\d{4}-\d{2}-\d{2}$/;

function sha256(s) {
  return crypto.createHash('sha256').update(s).digest('hex');
}

function emptyToNull(v) {
  if (v === undefined || v === null) return null;
  const s = String(v);
  return s === '' ? null : s;
}

// Same normalization the server uses to decide whether content changed: line
// endings, trailing whitespace and leading blank lines differ between editors,
// gray-matter and the web editor without changing what the reader sees.
function normalizeBody(v) {
  if (v === undefined || v === null) return null;
  const s = String(v).replace(/\r\n?/g, '\n').replace(/^(?:[ \t]*\n)+/, '').trimEnd();
  return s === '' ? null : s;
}

function isoOrNull(v) {
  if (v === undefined || v === null || v === '') return null;
  const d = new Date(v);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

function baseModel(src) {
  const title = src.title == null ? '' : String(src.title).trim();
  const subject = emptyToNull(src.subject);
  return {
    title,
    body_markdown: normalizeBody(src.body_markdown),
    description: emptyToNull(src.description),
    hero_image: emptyToNull(src.hero_image),
    web_visibility: emptyToNull(src.web_visibility) || 'listed',
    form_id: emptyToNull(src.form_id),
    email_enabled: src.email_enabled === true,
    // upsert-post stores the title when no subject is given.
    subject: subject === null ? title : subject,
    preheader: emptyToNull(src.preheader),
  };
}

/** Normalized view of a remote posts row. */
function remoteModel(row) {
  return { slug: row.slug || null, ...baseModel(row), date_override: isoOrNull(row.date_override) };
}

/** Normalized view of an upsert-post payload built from a local file. `date` is the normalized front-matter date or null. */
function localModel(payload) {
  // upsert-post enables email exactly when a list is set; a row can still hold
  // a list with email off (the editor's broadcast path), which a push re-enables.
  const formId = emptyToNull(payload.form_id);
  return {
    slug: payload.slug || null,
    ...baseModel({ ...payload, email_enabled: formId !== null }),
    date: payload.date || null,
  };
}

/**
 * Whether sending `localDate` (normalized front-matter date, or null for "no
 * date:") to upsert-post would change the row's dates. Mirrors upsert-post: a
 * null only clears a held date_override; on a published post a date matching
 * published_at (same UTC day for date-only, same instant otherwise) is a no-op;
 * on a draft the date replaces date_override.
 */
function dateWouldChange(localDate, row) {
  if (!localDate) return row.date_override != null && row.date_override !== '';

  const dateOnly = DATE_ONLY_RE.test(localDate);
  const value = new Date(dateOnly ? `${localDate}T00:00:00.000Z` : localDate);
  if (Number.isNaN(value.getTime())) return true;

  if (row.published_at) {
    const published = new Date(row.published_at);
    if (Number.isNaN(published.getTime())) return true;
    if (dateOnly) return value.toISOString().slice(0, 10) !== published.toISOString().slice(0, 10);
    return value.getTime() !== published.getTime();
  }

  const held = isoOrNull(row.date_override);
  return held === null || new Date(held).getTime() !== value.getTime();
}

/** Field names (SYNC_FIELDS plus "date") where pushing `local` would change `row`. */
function diffFields(local, row) {
  const remote = remoteModel(row);
  const changed = SYNC_FIELDS.filter((f) => local[f] !== remote[f]);
  if (dateWouldChange(local.date, row)) changed.push('date');
  return changed;
}

/** Stable hash of a remote row's synced fields. published_at is excluded: publishing alone isn't an edit. */
function remoteHash(row) {
  const model = remoteModel(row);
  const ordered = [...SYNC_FIELDS, 'date_override'].map((f) => [f, model[f]]);
  return `v1:${sha256(JSON.stringify(ordered))}`;
}

function localFieldHashes(local) {
  const out = {};
  for (const f of [...SYNC_FIELDS, 'date']) out[f] = sha256(JSON.stringify(local[f] === undefined ? null : local[f]));
  return out;
}

function localChangedSince(local, baseline) {
  if (!baseline || !baseline.fields) return true;
  const hashes = localFieldHashes(local);
  return Object.keys(hashes).some((f) => baseline.fields[f] !== hashes[f]);
}

/**
 * Decide what `posts push` should do with one local post.
 *
 * @param {object} args
 * @param {object} args.local          localModel() of the file
 * @param {object|null} args.remote    remote row with the same slug, if any
 * @param {object|null} args.baseline  sync-state entry for this post, if any
 * @param {object|null} args.baselineRemote  when there's no remote row, the
 *   remote row (if any) that the baseline's post id now belongs to
 * @returns {{ state: string, fields: string[], noBaseline?: boolean, renamedTo?: string }}
 *   state is one of created | updated | unchanged | behind | conflict |
 *   deleted-remotely | renamed-remotely.
 */
function classify({ local, remote, baseline, baselineRemote }) {
  if (!remote) {
    if (!baseline) return { state: 'created', fields: [] };
    if (baselineRemote && baselineRemote.slug) {
      return { state: 'renamed-remotely', fields: [], renamedTo: baselineRemote.slug };
    }
    return { state: 'deleted-remotely', fields: [] };
  }

  const fields = diffFields(local, remote);
  if (fields.length === 0) return { state: 'unchanged', fields };
  if (!baseline) return { state: 'updated', fields, noBaseline: true };
  if (baseline.hash === remoteHash(remote)) return { state: 'updated', fields };
  if (!localChangedSince(local, baseline)) return { state: 'behind', fields };
  return { state: 'conflict', fields };
}

function fieldLabels(fields) {
  return fields.map((f) => FIELD_LABELS[f] || f);
}

// ---------------------------------------------------------------------------
// Sync state file
// ---------------------------------------------------------------------------

function emptySyncState(projectId) {
  return { version: SYNC_STATE_VERSION, projectId, posts: {} };
}

/** Load the baseline; a missing, unreadable or other-project file counts as no baseline. */
function loadSyncState(cwd, projectId) {
  const filePath = path.join(cwd, SYNC_STATE_FILE);
  let data;
  try {
    data = JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch {
    return emptySyncState(projectId);
  }
  if (
    !data ||
    data.version !== SYNC_STATE_VERSION ||
    String(data.projectId) !== String(projectId) ||
    !data.posts ||
    typeof data.posts !== 'object'
  ) {
    return emptySyncState(projectId);
  }
  return data;
}

// Written via a temp file + rename so an interrupted push can't leave a
// truncated baseline that would misclassify every post next time.
function saveSyncState(cwd, state) {
  const filePath = path.join(cwd, SYNC_STATE_FILE);
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const tmp = `${filePath}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify(state, null, 2)}\n`, 'utf8');
  fs.renameSync(tmp, filePath);
}

function findBaselineBySlug(state, slug) {
  for (const [id, entry] of Object.entries(state.posts || {})) {
    if (entry && entry.slug === slug) return { id, entry };
  }
  return null;
}

// Never equals a remoteHash(), so the remote reads as changed since the baseline.
const UNCONFIRMED_HASH = 'unconfirmed';

function setEntry(state, postId, slug, hash, local, now) {
  for (const [id, entry] of Object.entries(state.posts)) {
    if (id !== String(postId) && entry && entry.slug === slug) delete state.posts[id];
  }
  state.posts[String(postId)] = {
    slug,
    hash,
    fields: localFieldHashes(local),
    syncedAt: now.toISOString(),
  };
}

/** Record that `row` (as stored remotely) and `local` (the file's model) are in sync. */
function recordSynced(state, row, local, now = new Date()) {
  setEntry(state, row.id, row.slug, remoteHash(row), local, now);
}

/**
 * Record a push whose stored row couldn't be confirmed (read-back failed or
 * already differs from what was pushed). Next push: unchanged if the remote
 * matches the file, otherwise "remote changed" or a conflict, never a silent
 * overwrite.
 */
function recordUnconfirmed(state, postId, slug, local, now = new Date()) {
  setEntry(state, postId, slug, UNCONFIRMED_HASH, local, now);
}

module.exports = {
  SYNC_STATE_FILE,
  SYNC_FIELDS,
  remoteModel,
  localModel,
  dateWouldChange,
  diffFields,
  remoteHash,
  localFieldHashes,
  classify,
  fieldLabels,
  loadSyncState,
  saveSyncState,
  findBaselineBySlug,
  recordSynced,
  recordUnconfirmed,
};
