'use strict';

const fs = require('fs');
const path = require('path');
const matter = require('gray-matter');

const { db, fn, handleAuthError, getValidAccessToken } = require('../supabase');
const { getProjectConfig } = require('../auth');
const { formatTable, formatDate } = require('../utils');
const { fetchRemoteFileIndex, resolveHeroImage, resolveBodyImages } = require('../posts-assets');

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

/** Resolve `list: <form name>` -> form_id via the `forms` table (case-insensitive, newsletter forms only). */
async function resolveFormId(projectId, listName) {
  const name = String(listName).trim();
  let forms;
  try {
    forms = await db
      .from('forms')
      .select('id,form_name,is_newsletter')
      .eq('project_id', projectId)
      .eq('is_newsletter', true)
      .get();
  } catch (err) {
    handleAuthError(err);
    throw new Error(`Failed to look up form "${name}": ${err.message}`);
  }

  const matches = (forms || []).filter(
    (f) => String(f.form_name || '').toLowerCase() === name.toLowerCase(),
  );
  if (matches.length === 0) {
    throw new Error(
      `No newsletter form named "${name}" found for this project. Check "micropage forms list".`,
    );
  }
  if (matches.length > 1) {
    throw new Error(`Multiple newsletter forms named "${name}" found — ambiguous. Rename one to disambiguate.`);
  }
  return matches[0].id;
}

function frontMatterFromPost(post) {
  const fmData = {
    title: post.title || '',
  };
  if (post.slug) fmData.slug = post.slug;
  if (post.description) fmData.description = post.description;
  if (post.web_visibility && post.web_visibility !== 'listed') fmData.visibility = post.web_visibility;
  if (post.hero_image) fmData.hero = post.hero_image;
  if (post.email_enabled) fmData.email = true;
  if (post.subject && post.subject !== post.title) fmData.subject = post.subject;
  if (post.preheader) fmData.preview = post.preheader;
  return fmData;
}

// ---------------------------------------------------------------------------
// posts push
// ---------------------------------------------------------------------------

async function push(options = {}) {
  const cwd = process.cwd();
  const config = requireProjectConfig(cwd);
  const postsDir = requirePostsDir(cwd);

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

  // Fetch remote posts once, both to report drift and to know created vs. updated.
  let remotePosts = [];
  try {
    remotePosts = await db
      .from('posts')
      .select('id,slug,title,web_visibility,email_enabled,status,created_at')
      .eq('project_id', config.projectId)
      .order('created_at', 'desc')
      .get();
  } catch (err) {
    handleAuthError(err);
    console.error('Failed to fetch remote posts:', err.message);
    process.exit(1);
  }
  const remoteBySlug = new Map((remotePosts || []).map((p) => [p.slug, p]));

  let fileIndex;
  try {
    fileIndex = await fetchRemoteFileIndex(config.projectId);
  } catch (err) {
    handleAuthError(err);
    console.error('Failed to list project files:', err.message);
    process.exit(1);
  }

  const localSlugs = new Set();
  const summary = [];
  let hadError = false;

  for (const filePath of localFiles) {
    const relName = path.relative(cwd, filePath);
    let raw;
    try {
      raw = fs.readFileSync(filePath, 'utf8');
    } catch (err) {
      console.error(`${relName}: failed to read (${err.message})`);
      hadError = true;
      continue;
    }

    let parsed;
    try {
      parsed = matter(raw);
    } catch (err) {
      console.error(`${relName}: invalid front-matter (${err.message})`);
      hadError = true;
      continue;
    }

    const fm = parsed.data || {};
    const title = typeof fm.title === 'string' ? fm.title.trim() : '';
    if (!title) {
      console.error(`${relName}: missing required front-matter field "title"`);
      hadError = true;
      continue;
    }

    const slug = fm.slug ? slugify(String(fm.slug)) : slugify(defaultSlugFromFilename(filePath));
    if (!slug) {
      console.error(`${relName}: could not derive a slug (set "slug:" in front-matter)`);
      hadError = true;
      continue;
    }
    localSlugs.add(slug);

    const visibility = fm.visibility || 'listed';
    if (!['listed', 'unlisted', 'none'].includes(visibility)) {
      console.error(`${relName}: invalid "visibility" (${visibility}); use listed, unlisted, or none`);
      hadError = true;
      continue;
    }

    const emailWanted = fm.email === true;
    let formId = null;
    if (emailWanted) {
      if (!fm.list) {
        console.error(`${relName}: "email: true" requires a "list:" front-matter field`);
        hadError = true;
        continue;
      }
      try {
        formId = await resolveFormId(config.projectId, fm.list);
      } catch (err) {
        console.error(`${relName}: ${err.message}`);
        hadError = true;
        continue;
      }
    }

    let heroUrl = null;
    try {
      const hero = await resolveHeroImage({
        accessToken,
        projectId: config.projectId,
        postFilePath: filePath,
        cwd,
        heroFrontMatter: fm.hero,
        fileIndex,
      });
      heroUrl = hero.url;
    } catch (err) {
      console.error(`${relName}: ${err.message}`);
      hadError = true;
      continue;
    }

    let bodyMarkdown;
    try {
      const resolvedBody = await resolveBodyImages({
        accessToken,
        projectId: config.projectId,
        postFilePath: filePath,
        cwd,
        body: parsed.content || '',
        fileIndex,
      });
      bodyMarkdown = resolvedBody.markdown;
      if (resolvedBody.unresolved && resolvedBody.unresolved.length > 0) {
        console.warn(
          `${relName}: warning — ${resolvedBody.unresolved.length} body image(s) not found locally, shipped as-is (will 404 if unhosted): ${resolvedBody.unresolved.join(', ')}`,
        );
      }
    } catch (err) {
      console.error(`${relName}: failed to resolve body images (${err.message})`);
      hadError = true;
      continue;
    }

    const payload = {
      project_id: config.projectId,
      title,
      slug,
      body_markdown: bodyMarkdown,
      description: fm.description || null,
      web_visibility: visibility,
      hero_image: heroUrl,
      email: emailWanted,
      form_id: formId,
      subject: fm.subject || null,
      preheader: fm.preview || null,
    };

    try {
      const result = await fn.invoke('upsert-post', payload);
      const bits = [`${result.action}`];
      if (result.emailed) bits.push('emailed');
      summary.push({ file: relName, slug, ok: true, note: bits.join(', ') });
      console.log(`${relName} -> "${slug}": ${bits.join(', ')}`);
    } catch (err) {
      handleAuthError(err);
      const msg = err.status === 409 ? 'slug already in use for another post' : err.message;
      console.error(`${relName}: upsert failed (${msg})`);
      summary.push({ file: relName, slug, ok: false, note: msg });
      hadError = true;
    }
  }

  // Drift report: remote posts with no matching local file. Never deleted here.
  const driftSlugs = (remotePosts || [])
    .map((p) => p.slug)
    .filter((slug) => slug && !localSlugs.has(slug));
  if (driftSlugs.length > 0) {
    console.log('');
    console.log(
      `Note: ${driftSlugs.length} remote post(s) have no local file in "${POSTS_DIR}/" (not deleted): ${driftSlugs.join(', ')}`,
    );
    console.log('Run "micropage posts pull" to fetch them locally, or "micropage posts rm <slug>" to delete remotely.');
  }

  console.log('');
  const okCount = summary.filter((s) => s.ok).length;
  console.log(`Pushed ${okCount}/${summary.length} post(s).`);

  if (hadError) process.exit(1);
}

// ---------------------------------------------------------------------------
// posts pull
// ---------------------------------------------------------------------------

async function pull(options = {}) {
  const cwd = process.cwd();
  const config = requireProjectConfig(cwd);
  const postsDir = path.join(cwd, POSTS_DIR);
  fs.mkdirSync(postsDir, { recursive: true });

  let remotePosts;
  try {
    remotePosts = await db
      .from('posts')
      .select(
        'id,slug,title,description,body_markdown,web_visibility,email_enabled,status,hero_image,created_at',
      )
      .eq('project_id', config.projectId)
      .order('created_at', 'desc')
      .get();
  } catch (err) {
    handleAuthError(err);
    console.error('Failed to fetch remote posts:', err.message);
    process.exit(1);
  }

  if (!Array.isArray(remotePosts) || remotePosts.length === 0) {
    console.log('No remote posts to pull.');
    return;
  }

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
      const ok = await confirmOverwrite(filename);
      if (!ok) {
        skipped += 1;
        continue;
      }
    }

    const fmData = frontMatterFromPost(post);
    const content = matter.stringify(post.body_markdown || '', fmData);
    fs.writeFileSync(filePath, content, 'utf8');
    written += 1;
    console.log(`Wrote ${path.relative(cwd, filePath)}`);
  }

  if (rl) rl.close();

  console.log('');
  console.log(`Pulled ${written} post(s)${skipped > 0 ? `, skipped ${skipped}` : ''}.`);
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
        'id,slug,title,web_visibility,email_enabled,status,created_at',
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
    p.email_enabled ? 'yes' : 'no',
    p.status || '-',
    formatDate(p.created_at),
  ]);
  formatTable(rows, ['Slug', 'Title', 'Visibility', 'Emailed', 'Status', 'Created']);
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

module.exports = { push, pull, list, rm };
