'use strict';

const fs = require('fs');
const path = require('path');
const matter = require('gray-matter');

const {
  db,
  fn,
  handleAuthError,
  getValidAccessToken,
  getMaxDeployEventIdForProject,
  streamDeployEventsUntilDone,
} = require('../supabase');
const { getProjectConfig } = require('../auth');
const { formatTable, formatDate } = require('../utils');
const { fetchRemoteFileIndex, resolveHeroImage, resolveBodyImages } = require('../posts-assets');
const {
  SYNC_STATE_FILE,
  localModel,
  diffFields,
  classify,
  fieldLabels,
  loadSyncState,
  saveSyncState,
  findBaselineBySlug,
  recordSynced,
  recordUnconfirmed,
  expectedRevision,
  isRevisionConflict,
  readBackMatches,
} = require('../posts-sync');

const POSTS_DIR = 'posts';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function requireProjectConfig(cwd) {
  const config = getProjectConfig(cwd);
  if (!config?.projectId) {
    console.error('Not in a project folder. Run from a folder with .micropage/project.json');
    process.exit(1);
  }
  return config;
}

function requirePostsDir(cwd) {
  const dir = path.join(cwd, POSTS_DIR);
  if (!fs.existsSync(dir) || !fs.statSync(dir).isDirectory()) {
    console.error(`No "${POSTS_DIR}/" folder found. Create one and add .md files, or run: micropage posts pull`);
    process.exit(1);
  }
  return dir;
}

function listLocalPostFiles(postsDir) {
  return fs
    .readdirSync(postsDir, { withFileTypes: true })
    .filter((e) => e.isFile() && e.name.endsWith('.md'))
    .map((e) => path.join(postsDir, e.name))
    .sort();
}

/** filename minus a leading date prefix (YYYY-MM-DD-) and the .md extension. */
function defaultSlugFromFilename(filePath) {
  const base = path.basename(filePath, '.md');
  return base.replace(/^\d{4}-\d{2}-\d{2}-/, '');
}

function slugify(s) {
  return String(s)
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

async function fetchNewsletterForms(projectId) {
  try {
    const forms = await db
      .from('forms')
      .select('id,form_name,is_newsletter')
      .eq('project_id', projectId)
      .eq('is_newsletter', true)
      .get();
    return forms || [];
  } catch (err) {
    handleAuthError(err);
    throw err;
  }
}

/**
 * Returns `list: <form name>` -> form_id resolution (case-insensitive,
 * newsletter forms only). The project's forms are fetched once, on first use.
 */
function makeListResolver(projectId, preloadedForms = null) {
  let formsPromise = preloadedForms ? Promise.resolve(preloadedForms) : null;
  return async (listName) => {
    const name = String(listName).trim();
    if (!formsPromise) formsPromise = fetchNewsletterForms(projectId);
    let forms;
    try {
      forms = await formsPromise;
    } catch (err) {
      formsPromise = null;
      throw new Error(`Failed to look up form "${name}": ${err.message}`);
    }

    const matches = forms.filter((f) => String(f.form_name || '').toLowerCase() === name.toLowerCase());
    if (matches.length === 0) {
      throw new Error(
        `No newsletter form named "${name}" found for this project. Check "micropage forms list".`,
      );
    }
    if (matches.length > 1) {
      throw new Error(`Multiple newsletter forms named "${name}" found — ambiguous. Rename one to disambiguate.`);
    }
    return matches[0].id;
  };
}

const DATE_ONLY_RE = /^(\d{4})-(\d{2})-(\d{2})$/;
const ISO_DATETIME_RE =
  /^(\d{4}-\d{2}-\d{2})[Tt ](\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?)\s*([Zz]|[+-]\d{2}(?::?\d{2})?)?$/;
// Date-only values are midnight UTC server-side; allow "today" anywhere on
// Earth (UTC+14) so a local-calendar date isn't rejected as future.
const DATE_ONLY_FUTURE_SLACK_MS = 14 * 60 * 60 * 1000;
const DATETIME_FUTURE_SLACK_MS = 5 * 60 * 1000;

function utcDateString(d) {
  return d.toISOString().slice(0, 10);
}

function isoOffset(raw) {
  if (!raw || raw === 'z' || raw === 'Z') return 'Z';
  const digits = raw.slice(1).replace(':', '');
  return `${raw[0]}${digits.slice(0, 2)}:${digits.slice(2) || '00'}`;
}

function isMidnightUtc(d) {
  return (
    d.getUTCHours() === 0 && d.getUTCMinutes() === 0 && d.getUTCSeconds() === 0 && d.getUTCMilliseconds() === 0
  );
}

/**
 * Normalize a front-matter `date` into what upsert-post accepts: `YYYY-MM-DD`
 * or a full ISO timestamp. js-yaml turns unquoted dates into Date objects
 * (UTC), quoted ones stay strings. Returns null when absent; throws on
 * invalid or future values (scheduling isn't supported).
 */
function normalizePostDate(value, now = new Date()) {
  if (value === undefined || value === null || value === '') return null;

  let normalized;
  if (value instanceof Date) {
    if (Number.isNaN(value.getTime())) throw new Error('invalid "date" (not a valid date)');
    normalized = isMidnightUtc(value) ? utcDateString(value) : value.toISOString();
  } else if (typeof value === 'string') {
    const s = value.trim();
    const dateOnly = DATE_ONLY_RE.exec(s);
    if (dateOnly) {
      const d = new Date(`${s}T00:00:00.000Z`);
      if (Number.isNaN(d.getTime()) || utcDateString(d) !== s) {
        throw new Error(`invalid "date" (${s}); use YYYY-MM-DD or an ISO timestamp`);
      }
      normalized = s;
    } else {
      const m = ISO_DATETIME_RE.exec(s);
      // A timestamp without an offset is read as UTC, matching how YAML
      // resolves unquoted timestamps.
      const d = m ? new Date(`${m[1]}T${m[2]}${isoOffset(m[3])}`) : null;
      if (!d || Number.isNaN(d.getTime()) || utcDateString(new Date(`${m[1]}T00:00:00.000Z`)) !== m[1]) {
        throw new Error(`invalid "date" (${s}); use YYYY-MM-DD or an ISO timestamp`);
      }
      normalized = d.toISOString();
    }
  } else {
    throw new Error(`invalid "date" (${String(value)}); use YYYY-MM-DD or an ISO timestamp`);
  }

  const isFuture = DATE_ONLY_RE.test(normalized)
    ? Date.parse(`${normalized}T00:00:00Z`) > now.getTime() + DATE_ONLY_FUTURE_SLACK_MS
    : new Date(normalized).getTime() > now.getTime() + DATETIME_FUTURE_SLACK_MS;
  if (isFuture) {
    throw new Error(`"date" ${normalized} is in the future; scheduling posts is not supported`);
  }
  return normalized;
}

/**
 * Front-matter for a pulled post. `formNameById` maps newsletter form ids to
 * names so an email post gets the `list:` that push needs to keep emailing it.
 */
function frontMatterFromPost(post, formNameById = new Map()) {
  const fmData = {
    title: post.title || '',
  };
  if (post.slug) fmData.slug = post.slug;
  if (post.published_at) {
    const published = new Date(post.published_at);
    if (!Number.isNaN(published.getTime())) fmData.date = utcDateString(published);
  } else if (post.date_override) {
    // A draft's held date must round-trip: push sends date: null for files without one,
    // which clears it.
    const held = new Date(post.date_override);
    if (!Number.isNaN(held.getTime())) fmData.date = isMidnightUtc(held) ? utcDateString(held) : held.toISOString();
  }
  if (post.description) fmData.description = post.description;
  if (post.web_visibility && post.web_visibility !== 'listed') fmData.visibility = post.web_visibility;
  if (post.hero_image) fmData.hero = post.hero_image;
  if (post.email_enabled) {
    fmData.email = true;
    const listName = post.form_id ? formNameById.get(post.form_id) : null;
    if (listName) fmData.list = listName;
  }
  if (post.subject && post.subject !== post.title) fmData.subject = post.subject;
  if (post.preheader) fmData.preview = post.preheader;
  return fmData;
}

// ---------------------------------------------------------------------------
// posts push
// ---------------------------------------------------------------------------

const POST_SYNC_COLUMNS =
  'id,slug,title,description,body_markdown,web_visibility,hero_image,form_id,subject,preheader,published_at,date_override,email_enabled,revision';

const VISIBILITY_VALUES = ['listed', 'unlisted', 'none'];

function slugForFile(filePath, fm) {
  return fm.slug ? slugify(String(fm.slug)) : slugify(defaultSlugFromFilename(filePath));
}

/** Parse a local post file far enough to know its slug. Throws with a user-facing message. */
function readLocalPost(filePath) {
  let raw;
  try {
    raw = fs.readFileSync(filePath, 'utf8');
  } catch (err) {
    throw new Error(`failed to read (${err.message})`);
  }
  let parsed;
  try {
    parsed = matter(raw);
  } catch (err) {
    throw new Error(`invalid front-matter (${err.message})`);
  }
  const fm = parsed.data || {};
  return { fm, content: parsed.content || '', slug: slugForFile(filePath, fm) };
}

/**
 * Build the upsert-post payload for a local post. With `upload: false`, local
 * images that aren't uploaded yet are listed in `pendingUploads` rather than
 * uploaded. Throws with a user-facing message.
 */
async function buildPostPayload({ filePath, fm, content, slug, cwd, projectId, accessToken, fileIndex, resolveList, upload }) {
  const title = typeof fm.title === 'string' ? fm.title.trim() : '';
  if (!title) throw new Error('missing required front-matter field "title"');
  if (!slug) throw new Error('could not derive a slug (set "slug:" in front-matter)');

  const visibility = fm.visibility || 'listed';
  if (!VISIBILITY_VALUES.includes(visibility)) {
    throw new Error(`invalid "visibility" (${visibility}); use listed, unlisted or none`);
  }

  const postDate = normalizePostDate(fm.date);

  let formId = null;
  if (fm.email === true) {
    if (!fm.list) throw new Error('"email: true" requires a "list:" front-matter field');
    formId = await resolveList(fm.list);
  }

  const hero = await resolveHeroImage({
    accessToken,
    projectId,
    postFilePath: filePath,
    cwd,
    heroFrontMatter: fm.hero,
    fileIndex,
    upload,
  });

  let resolvedBody;
  try {
    resolvedBody = await resolveBodyImages({
      accessToken,
      projectId,
      postFilePath: filePath,
      cwd,
      body: content,
      fileIndex,
      upload,
    });
  } catch (err) {
    throw new Error(`failed to resolve body images (${err.message})`);
  }

  const payload = {
    project_id: projectId,
    title,
    slug,
    body_markdown: resolvedBody.markdown,
    description: fm.description || null,
    web_visibility: visibility,
    hero_image: hero.url,
    form_id: formId,
    subject: fm.subject || null,
    preheader: fm.preview || null,
  };
  // An explicit null tells the server the file has no date:, so a held draft date is cleared.
  payload.date = postDate || null;

  const pendingUploads = [...new Set([...(hero.pendingUploads || []), ...(resolvedBody.pendingUploads || [])])];
  return { payload, pendingUploads, unresolved: resolvedBody.unresolved || [] };
}

const BLOCKED_STATES = new Set(['behind', 'conflict', 'deleted-remotely', 'renamed-remotely']);

function blockedMessage(cls, slug) {
  switch (cls.state) {
    case 'behind':
      return `skipped, remote changed since last sync (edited in the editor?). Run "micropage posts pull ${slug}" to update your file.`;
    case 'conflict':
      return `CONFLICT, changed locally and remotely since last sync. Not pushed. Save your edits, then "micropage posts pull ${slug}", or overwrite the remote with "micropage posts push ${slug} --force".`;
    case 'deleted-remotely':
      return `skipped, deleted remotely since last sync. Remove the file, or recreate the post with "micropage posts push ${slug} --force".`;
    case 'renamed-remotely':
      return `skipped, renamed remotely to "${cls.renamedTo}". Run "micropage posts pull ${cls.renamedTo}" and remove this file, or create a separate post with "micropage posts push ${slug} --force".`;
    default:
      return 'skipped';
  }
}

/** What a push of a classified post does, e.g. `updated (body, hero)`. */
function describePush(cls, dryRun = false) {
  const fields = fieldLabels(cls.fields).join(', ');
  switch (cls.state) {
    case 'created':
      return 'created';
    case 'deleted-remotely':
      return 'created (was deleted remotely)';
    case 'renamed-remotely':
      return `created (the post this file was synced with is now "${cls.renamedTo}")`;
    case 'behind':
    case 'conflict':
      return `updated (${fields}; ${dryRun ? 'would overwrite' : 'overwrote'} remote changes)`;
    default:
      return cls.noBaseline
        ? `updated (${fields}; no sync record, remote edits not checked)`
        : `updated (${fields})`;
  }
}

async function push(slugArgs = [], options = {}) {
  const cwd = process.cwd();
  const config = requireProjectConfig(cwd);
  const postsDir = requirePostsDir(cwd);
  const dryRun = Boolean(options.dryRun);
  const force = Boolean(options.force);

  const localFiles = listLocalPostFiles(postsDir);
  if (localFiles.length === 0) {
    console.log(`No .md files found in "${POSTS_DIR}/". Nothing to push.`);
    return;
  }

  let accessToken;
  try {
    accessToken = await getValidAccessToken();
  } catch (err) {
    handleAuthError(err);
    console.error('Failed to authenticate:', err.message);
    process.exit(1);
  }

  // Fetch remote posts once: change detection, created vs. updated, and the drift report.
  let remotePosts = [];
  try {
    remotePosts = await db
      .from('posts')
      .select(POST_SYNC_COLUMNS)
      .eq('project_id', config.projectId)
      .order('created_at', 'desc')
      .get();
  } catch (err) {
    handleAuthError(err);
    console.error('Failed to fetch remote posts:', err.message);
    process.exit(1);
  }
  remotePosts = remotePosts || [];
  const remoteBySlug = new Map(remotePosts.map((p) => [p.slug, p]));
  const remoteById = new Map(remotePosts.map((p) => [String(p.id), p]));

  let fileIndex;
  try {
    fileIndex = await fetchRemoteFileIndex(config.projectId);
  } catch (err) {
    handleAuthError(err);
    console.error('Failed to list project files:', err.message);
    process.exit(1);
  }

  const resolveList = makeListResolver(config.projectId);
  const state = loadSyncState(cwd, config.projectId);
  let stateDirty = false;

  const wanted = slugArgs.length > 0 ? new Set(slugArgs.map((s) => slugify(String(s)))) : null;
  const found = new Set();
  const localSlugs = new Set();
  const counts = { created: 0, updated: 0, unchanged: 0, skipped: 0, conflict: 0, failed: 0 };
  const pushed = [];
  let hadError = false;

  for (const filePath of localFiles) {
    const relName = path.relative(cwd, filePath);

    let post;
    try {
      post = readLocalPost(filePath);
    } catch (err) {
      // With slugs given, an unreadable file can only be matched by its filename;
      // other requested slugs with no readable file are reported below.
      if (wanted) {
        const fileSlug = slugify(defaultSlugFromFilename(filePath));
        if (!wanted.has(fileSlug)) continue;
        found.add(fileSlug);
      }
      console.error(`${relName}: ${err.message}`);
      counts.failed += 1;
      hadError = true;
      continue;
    }
    if (wanted && !wanted.has(post.slug)) continue;
    if (post.slug) {
      localSlugs.add(post.slug);
      found.add(post.slug);
    }

    const buildArgs = {
      filePath,
      fm: post.fm,
      content: post.content,
      slug: post.slug,
      cwd,
      projectId: config.projectId,
      accessToken,
      fileIndex,
      resolveList,
    };

    // Lookup pass: resolve images without uploading so an unchanged post costs no writes.
    let built;
    try {
      built = await buildPostPayload({ ...buildArgs, upload: false });
    } catch (err) {
      handleAuthError(err);
      console.error(`${relName}: ${err.message}`);
      counts.failed += 1;
      hadError = true;
      continue;
    }
    if (built.unresolved.length > 0) {
      console.warn(
        `${relName}: warning — ${built.unresolved.length} body image(s) not found locally, shipped as-is (will 404 if unhosted): ${built.unresolved.join(', ')}`,
      );
    }

    const local = localModel(built.payload);
    const remote = remoteBySlug.get(post.slug) || null;
    let baseline = null;
    let baselineRemote = null;
    if (remote) {
      baseline = state.posts[String(remote.id)] || null;
    } else {
      const entry = findBaselineBySlug(state, post.slug);
      if (entry) {
        baseline = entry.entry;
        baselineRemote = remoteById.get(entry.id) || null;
      }
    }
    const cls = classify({ local, remote, baseline, baselineRemote });
    const prefix = `${relName} -> "${post.slug}"`;

    if (cls.state === 'unchanged') {
      counts.unchanged += 1;
      console.log(`${prefix}: unchanged`);
      if (!dryRun) {
        recordSynced(state, remote, local);
        stateDirty = true;
      }
      continue;
    }

    if (BLOCKED_STATES.has(cls.state) && !force) {
      const msg = `${prefix}: ${blockedMessage(cls, post.slug)}`;
      if (cls.state === 'conflict') counts.conflict += 1;
      else counts.skipped += 1;
      if (cls.state === 'behind') {
        console.log(msg);
      } else {
        console.error(msg);
        hadError = true;
      }
      continue;
    }

    const detail = describePush(cls, dryRun);
    const countKey = remote ? 'updated' : 'created';

    if (dryRun) {
      const uploads = built.pendingUploads.length > 0 ? `, would upload ${built.pendingUploads.length} image(s)` : '';
      console.log(`${prefix}: would be ${detail}${uploads}`);
      counts[countKey] += 1;
      continue;
    }

    let payload = built.payload;
    let syncedLocal = local;
    if (built.pendingUploads.length > 0) {
      try {
        payload = (await buildPostPayload({ ...buildArgs, upload: true })).payload;
        syncedLocal = localModel(payload);
      } catch (err) {
        handleAuthError(err);
        console.error(`${relName}: ${err.message}`);
        counts.failed += 1;
        hadError = true;
        continue;
      }
    }

    const expected = expectedRevision({ remote, force });
    if (expected !== undefined) payload = { ...payload, expected_revision: expected };

    try {
      const result = await fn.invoke('upsert-post', payload);
      const where = result.published ? (result.rebuild_build_id ? 'live; site rebuild queued' : 'live') : 'draft';
      console.log(`${prefix}: ${detail}, saved (${where})`);
      counts[result.action === 'created' ? 'created' : 'updated'] += 1;
      pushed.push({ postId: result.post_id, slug: post.slug, local: syncedLocal, revision: result.revision });
    } catch (err) {
      handleAuthError(err);
      if (isRevisionConflict(err)) {
        console.error(
          `${prefix}: CONFLICT, the post changed remotely during this push. Not pushed. Run "micropage posts pull ${post.slug}", or overwrite with "micropage posts push ${post.slug} --force".`,
        );
        counts.conflict += 1;
        hadError = true;
        continue;
      }
      const msg = err.status === 409 ? 'slug already in use for another post' : err.message;
      console.error(`${relName}: upsert failed (${msg})`);
      counts.failed += 1;
      hadError = true;
    }
  }

  if (wanted) {
    for (const slug of wanted) {
      if (found.has(slug)) continue;
      console.error(`"${slug}": no post file in "${POSTS_DIR}/" with this slug`);
      counts.failed += 1;
      hadError = true;
    }
  }

  // The baseline is the row as the server stored it, read back once for all
  // pushed posts. A row that differs from what was pushed, or whose revision
  // moved past the one the save returned, was edited in between.
  if (pushed.length > 0) {
    let rows = [];
    try {
      rows =
        (await db
          .from('posts')
          .select(POST_SYNC_COLUMNS)
          .eq('project_id', config.projectId)
          .in('slug', pushed.map((p) => p.slug))
          .get()) || [];
    } catch (err) {
      handleAuthError(err);
      console.warn(
        `Warning: could not read back the pushed posts (${err.message}); the next push re-checks them against the remote.`,
      );
    }
    const rowsBySlug = new Map(rows.map((r) => [r.slug, r]));
    for (const p of pushed) {
      const row = rowsBySlug.get(p.slug);
      if (readBackMatches(row, p)) {
        recordSynced(state, row, p.local);
      } else {
        recordUnconfirmed(state, p.postId, p.slug, p.local);
      }
    }
    stateDirty = true;
  }

  if (stateDirty && !dryRun) {
    try {
      saveSyncState(cwd, state);
    } catch (err) {
      console.warn(`Warning: could not save ${SYNC_STATE_FILE} (${err.message}).`);
    }
  }

  // Drift report: remote posts with no matching local file. Never deleted here.
  const driftSlugs = wanted
    ? []
    : remotePosts.map((p) => p.slug).filter((slug) => slug && !localSlugs.has(slug));
  if (driftSlugs.length > 0) {
    console.log('');
    console.log(
      `Note: ${driftSlugs.length} remote post(s) have no local file in "${POSTS_DIR}/" (not deleted): ${driftSlugs.join(', ')}`,
    );
    console.log('Run "micropage posts pull" to fetch them locally, or "micropage posts rm <slug>" to delete remotely.');
  }

  console.log('');
  const tally = `${counts.created} created, ${counts.updated} updated, ${counts.unchanged} unchanged, ${counts.skipped} skipped, ${counts.conflict} conflict, ${counts.failed} failed.`;
  console.log(dryRun ? `Dry run, nothing written: ${tally}` : tally);

  if (hadError) process.exit(1);
}

// ---------------------------------------------------------------------------
// posts pull
// ---------------------------------------------------------------------------

async function pull(slugArgs = [], options = {}) {
  const cwd = process.cwd();
  const config = requireProjectConfig(cwd);
  const postsDir = path.join(cwd, POSTS_DIR);
  fs.mkdirSync(postsDir, { recursive: true });

  let remotePosts;
  try {
    remotePosts = await db
      .from('posts')
      .select(`${POST_SYNC_COLUMNS},status,created_at`)
      .eq('project_id', config.projectId)
      .order('created_at', 'desc')
      .get();
  } catch (err) {
    handleAuthError(err);
    console.error('Failed to fetch remote posts:', err.message);
    process.exit(1);
  }
  remotePosts = Array.isArray(remotePosts) ? remotePosts : [];

  let hadError = false;
  if (slugArgs.length > 0) {
    const wanted = new Set(slugArgs.map((s) => slugify(String(s))));
    for (const slug of wanted) {
      if (!remotePosts.some((p) => p.slug === slug)) {
        console.error(`"${slug}": no remote post with this slug`);
        hadError = true;
      }
    }
    remotePosts = remotePosts.filter((p) => wanted.has(p.slug));
  }

  if (remotePosts.length === 0) {
    if (!hadError) console.log('No remote posts to pull.');
    if (hadError) process.exit(1);
    return;
  }

  let forms = null;
  try {
    forms = await fetchNewsletterForms(config.projectId);
  } catch (err) {
    console.warn(`Warning: could not load newsletter forms (${err.message}); email posts are written without "list:".`);
  }
  const formNameById = new Map((forms || []).map((f) => [f.id, f.form_name]));
  const resolveList = makeListResolver(config.projectId, forms);
  const state = loadSyncState(cwd, config.projectId);
  let stateDirty = false;

  let fileIndexPromise = null;
  const getFileIndex = () => {
    if (!fileIndexPromise) fileIndexPromise = fetchRemoteFileIndex(config.projectId);
    return fileIndexPromise;
  };

  // A local file counts as current when pushing it would change nothing.
  const localMatches = async (filePath, post) => {
    try {
      const local = readLocalPost(filePath);
      if (local.slug !== post.slug) return null;
      const built = await buildPostPayload({
        filePath,
        fm: local.fm,
        content: local.content,
        slug: local.slug,
        cwd,
        projectId: config.projectId,
        accessToken: null,
        fileIndex: await getFileIndex(),
        resolveList,
        upload: false,
      });
      const model = localModel(built.payload);
      return diffFields(model, post).length === 0 ? model : null;
    } catch (err) {
      handleAuthError(err);
      return null;
    }
  };

  let rl = null;
  const confirmOverwrite = async (filename) => {
    if (options.force) return true;
    if (!rl) {
      const readline = require('readline');
      rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    }
    const answer = await new Promise((resolve) => {
      rl.question(`Overwrite "${filename}"? [y/N] `, (a) => resolve((a || '').trim().toLowerCase()));
    });
    return answer === 'y' || answer === 'yes';
  };

  let written = 0;
  let unchanged = 0;
  let skipped = 0;

  for (const post of remotePosts) {
    if (!post.slug) {
      console.warn(`Skipping post ${post.id}: no slug set.`);
      skipped += 1;
      continue;
    }
    const filename = `${post.slug}.md`;
    const filePath = path.join(postsDir, filename);

    if (fs.existsSync(filePath)) {
      const current = await localMatches(filePath, post);
      if (current) {
        console.log(`${path.relative(cwd, filePath)}: unchanged`);
        recordSynced(state, post, current);
        stateDirty = true;
        unchanged += 1;
        continue;
      }
      const ok = await confirmOverwrite(filename);
      if (!ok) {
        skipped += 1;
        continue;
      }
    }

    const fmData = frontMatterFromPost(post, formNameById);
    const content = matter.stringify(post.body_markdown || '', fmData);
    fs.writeFileSync(filePath, content, 'utf8');
    written += 1;
    console.log(`Wrote ${path.relative(cwd, filePath)}`);

    let pulledDate = null;
    try {
      pulledDate = normalizePostDate(fmData.date);
    } catch {
      pulledDate = null;
    }
    recordSynced(
      state,
      post,
      localModel({
        slug: post.slug,
        title: post.title,
        body_markdown: post.body_markdown,
        description: post.description,
        hero_image: post.hero_image,
        web_visibility: post.web_visibility,
        form_id: fmData.list ? post.form_id : null,
        subject: fmData.subject || null,
        preheader: post.preheader,
        date: pulledDate,
      }),
    );
    stateDirty = true;
  }

  if (rl) rl.close();

  if (stateDirty) {
    try {
      saveSyncState(cwd, state);
    } catch (err) {
      console.warn(`Warning: could not save ${SYNC_STATE_FILE} (${err.message}).`);
    }
  }

  console.log('');
  const extras = [];
  if (unchanged > 0) extras.push(`${unchanged} unchanged`);
  if (skipped > 0) extras.push(`skipped ${skipped}`);
  console.log(`Pulled ${written} post(s)${extras.length > 0 ? `, ${extras.join(', ')}` : ''}.`);

  if (hadError) process.exit(1);
}

// ---------------------------------------------------------------------------
// posts list
// ---------------------------------------------------------------------------

async function list(options = {}) {
  const cwd = process.cwd();
  const config = requireProjectConfig(cwd);

  let posts;
  try {
    posts = await db
      .from('posts')
      .select(
        'id,slug,title,web_visibility,email_enabled,status,published_at,created_at',
      )
      .eq('project_id', config.projectId)
      .order('created_at', 'desc')
      .get();
  } catch (err) {
    handleAuthError(err);
    console.error('Failed to list posts:', err.message);
    process.exit(1);
  }

  if (!Array.isArray(posts) || posts.length === 0) {
    console.log('No posts for this project.');
    return;
  }

  if (options.json) {
    console.log(JSON.stringify(posts, null, 2));
    return;
  }

  const rows = posts.map((p) => [
    p.slug || '-',
    p.title || '-',
    p.web_visibility || '-',
    p.published_at ? 'Published' : 'Draft',
    p.email_enabled ? 'yes' : 'no',
    // `status` tracks the newsletter send lifecycle only; it says nothing about
    // deploy state, so it's meaningless (and misleading — reads as "pending") for
    // web-only posts. Show it only when the post actually emails.
    p.email_enabled ? (p.status || '-') : '-',
    formatDate(p.created_at),
  ]);
  formatTable(rows, ['Slug', 'Title', 'Visibility', 'Published', 'Emailed', 'Send status', 'Created']);
}

// ---------------------------------------------------------------------------
// posts rm <slug>
// ---------------------------------------------------------------------------

async function rm(slug, options = {}) {
  if (!slug) {
    console.error('Usage: micropage posts rm <slug>');
    process.exit(1);
  }
  const cwd = process.cwd();
  const config = requireProjectConfig(cwd);

  let result;
  try {
    result = await fn.invoke('delete-post', { project_id: config.projectId, slug });
  } catch (err) {
    handleAuthError(err);
    console.error('Failed to delete post:', err.message);
    process.exit(1);
  }

  if (result?.deleted) {
    console.log(`Deleted post "${slug}" (remote rebuild triggered if the project is deployed).`);
  } else {
    console.log(`No post found with slug "${slug}" — nothing to delete.`);
  }
}

// ---------------------------------------------------------------------------
// posts publish [slug]
// ---------------------------------------------------------------------------

/** Slugs to target when no explicit slug is given: every local posts/*.md file's resolved slug. */
function localSlugsFromPostsDir(postsDir) {
  const slugs = [];
  for (const filePath of listLocalPostFiles(postsDir)) {
    let fm = {};
    try {
      fm = matter(fs.readFileSync(filePath, 'utf8')).data || {};
    } catch {
      continue;
    }
    const slug = slugForFile(filePath, fm);
    if (slug) slugs.push(slug);
  }
  return slugs;
}

/** Whether publish-post has already queued or sent this post's email. */
function wasEmailed(row) {
  return (
    Number(row.sent_count) > 0 ||
    Number(row.recipient_count) > 0 ||
    row.started_at != null ||
    row.status === 'sending' ||
    row.status === 'sent'
  );
}

/**
 * The build the publish-post rebuilds redeploy. Servers that report
 * rebuild_build_id rebuild the live build, never a page draft; older ones
 * leave it out and rebuild the project's active build.
 */
function rebuildTarget(responses, activeBuildId) {
  const reported = responses.filter((r) => r && Object.prototype.hasOwnProperty.call(r, 'rebuild_build_id'));
  if (reported.length === 0) return { buildId: activeBuildId || null, serverReported: false };
  const ids = reported.map((r) => r.rebuild_build_id).filter((id) => id != null);
  return { buildId: ids.length > 0 ? ids[ids.length - 1] : null, serverReported: true };
}

async function publish(slugArg, options = {}) {
  const cwd = process.cwd();
  const config = requireProjectConfig(cwd);

  let targetSlugs;
  if (slugArg) {
    targetSlugs = [slugify(String(slugArg))];
  } else {
    const postsDir = requirePostsDir(cwd);
    targetSlugs = localSlugsFromPostsDir(postsDir);
    if (targetSlugs.length === 0) {
      console.log(`No .md files found in "${POSTS_DIR}/". Nothing to publish.`);
      return;
    }
  }

  // Publishing an already-published email post re-snapshots its recipients and
  // emails the list again, so live posts are skipped (no slug) or need --resend.
  let remotePosts;
  try {
    remotePosts = await db
      .from('posts')
      .select('id,slug,published_at,email_enabled,form_id,status,recipient_count,sent_count,started_at')
      .eq('project_id', config.projectId)
      .get();
  } catch (err) {
    handleAuthError(err);
    console.error('Failed to fetch remote posts:', err.message);
    process.exit(1);
  }
  const remoteBySlug = new Map((remotePosts || []).map((p) => [p.slug, p]));

  let hadError = false;
  let skippedLive = 0;
  const toPublish = [];
  for (const slug of targetSlugs) {
    const row = remoteBySlug.get(slug);
    if (!row) {
      console.error(`"${slug}": publish failed (post not found (push it first with "micropage posts push"))`);
      hadError = true;
      continue;
    }
    const emailsList = Boolean(row.email_enabled && row.form_id);
    // Unpublishing clears published_at but not the send record, so an emailed
    // post taken down and republished would email its list again.
    const emailed = emailsList && wasEmailed(row);
    if (!slugArg && row.published_at) {
      console.log(`"${slug}": already live, skipped${emailsList ? ' (no email re-sent)' : ''}`);
      skippedLive += 1;
      continue;
    }
    if (!slugArg && emailed) {
      console.log(`"${slug}": already emailed, skipped (no email re-sent; use "micropage posts publish ${slug} --resend")`);
      skippedLive += 1;
      continue;
    }
    if (emailsList && (row.published_at || emailed) && !options.resend) {
      console.error(
        `"${slug}": already ${row.published_at ? 'published' : 'emailed'}; publishing it again re-sends the email to the list's current subscribers. Re-run with --resend to do that.`,
      );
      hadError = true;
      continue;
    }
    toPublish.push(row);
  }

  const summarize = (publishedCount) => {
    console.log('');
    const skippedNote = skippedLive > 0 ? `, skipped ${skippedLive} already live or emailed` : '';
    console.log(`Published ${publishedCount}/${toPublish.length} post(s)${skippedNote}.`);
  };

  if (toPublish.length === 0) {
    summarize(0);
    if (hadError) process.exit(1);
    return;
  }

  if (toPublish.some((row) => row.email_enabled)) {
    console.warn(
      toPublish.some((row) => row.email_enabled && (row.published_at || wasEmailed(row)))
        ? 'Publishing sends email to the active subscriber list for email-configured posts, including re-sends (--resend).'
        : 'Publishing sends email to the active subscriber list for email-configured posts.',
    );
  }

  // Publishing a post makes the publisher auto-rebuild the live site so the
  // /content archive picks it up — no separate `micropage publish` needed.
  // publish-post reports which build it rebuilds; active_build_id is only the
  // fallback for servers that don't. The --watch cursor is project-wide and
  // taken before the rebuild is queued, since the build isn't known yet.
  let activeBuildId = null;
  try {
    const proj = await db
      .from('projects')
      .select('active_build_id')
      .eq('id', config.projectId)
      .single();
    activeBuildId = proj?.active_build_id || null;
  } catch {
    // best-effort; treated as "unknown" below
  }

  let eventCursor = 0;
  if (options.watch) {
    try {
      eventCursor = await getMaxDeployEventIdForProject(config.projectId);
    } catch {
      eventCursor = 0;
    }
  }

  let publishedCount = 0;
  const responses = [];

  for (const { slug } of toPublish) {
    try {
      const result = await fn.invoke('publish-post', { project_id: config.projectId, slug });
      responses.push(result);
      const bits = [`published_at ${result.published_at}`];
      bits.push(result.emailed ? `emailed ${result.recipient_count} recipient(s)` : 'no email');
      console.log(`"${slug}": ${bits.join(', ')}`);
      publishedCount += 1;
    } catch (err) {
      handleAuthError(err);
      const msg = err.status === 404 ? 'post not found (push it first with "micropage posts push")' : err.message;
      console.error(`"${slug}": publish failed (${msg})`);
      hadError = true;
    }
  }

  summarize(publishedCount);

  if (publishedCount > 0) {
    const { buildId: rebuildBuildId, serverReported } = rebuildTarget(responses, activeBuildId);
    if (rebuildBuildId) {
      console.log(
        'A site rebuild was queued automatically; the /content archive updates once it deploys (usually a minute or two).',
      );
    } else if (serverReported) {
      console.log(
        "No site rebuild was queued: the project has no deployed build yet (run 'micropage publish'), or the post is email-only.",
      );
    } else {
      console.log(
        "Note: this project hasn't been published yet, so the post won't appear until you run 'micropage publish'.",
      );
    }

    if (options.watch && rebuildBuildId) {
      console.log('');
      console.log('Build / deploy events:');
      try {
        const accessToken = await getValidAccessToken();
        const { terminalEvent } = await streamDeployEventsUntilDone(
          accessToken,
          config.projectId,
          rebuildBuildId,
          { afterId: eventCursor },
        );
        if (terminalEvent?.event_type === 'build.failed') {
          const msg =
            (terminalEvent.payload && (terminalEvent.payload.error || terminalEvent.payload.message)) ||
            'Build failed';
          console.error(msg);
          process.exit(1);
        }
      } catch (streamErr) {
        console.error('Event stream failed:', streamErr.message);
        process.exit(1);
      }
    }
  }

  if (hadError) process.exit(1);
}

// ---------------------------------------------------------------------------
// posts unpublish <slug>
// ---------------------------------------------------------------------------

async function unpublish(slug) {
  if (!slug) {
    console.error('Usage: micropage posts unpublish <slug>');
    process.exit(1);
  }
  const cwd = process.cwd();
  const config = requireProjectConfig(cwd);

  let result;
  try {
    result = await fn.invoke('unpublish-post', { project_id: config.projectId, slug: slugify(String(slug)) });
  } catch (err) {
    handleAuthError(err);
    const msg = err.status === 404 ? 'post not found' : err.message;
    console.error(`Failed to unpublish post: ${msg}`);
    process.exit(1);
  }

  if (result?.unpublished) {
    console.log(`Unpublished post "${slug}" (removed from the site; remains as a draft).`);
  } else {
    console.log(`No post found with slug "${slug}" — nothing to unpublish.`);
  }
}

module.exports = {
  push,
  pull,
  list,
  rm,
  publish,
  unpublish,
  rebuildTarget,
  slugify,
  defaultSlugFromFilename,
  frontMatterFromPost,
  normalizePostDate,
};
