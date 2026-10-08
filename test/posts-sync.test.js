'use strict';
/**
 * Unit tests for cli/src/posts-sync.js (change detection + sync-state file)
 * and the lookup mode of cli/src/posts-assets.js. Network calls are stubbed.
 */

const { test, describe, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const supabase = require('../src/supabase');
const {
  SYNC_STATE_FILE,
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
} = require('../src/posts-sync');
const { resolveHeroImage, resolveBodyImages } = require('../src/posts-assets');

function row(overrides = {}) {
  return {
    id: 'p1',
    slug: 'hello',
    title: 'Hello',
    description: null,
    body_markdown: 'Body text',
    web_visibility: 'listed',
    hero_image: null,
    form_id: null,
    email_enabled: false,
    subject: 'Hello',
    preheader: null,
    published_at: null,
    date_override: null,
    ...overrides,
  };
}

function payload(overrides = {}) {
  return {
    project_id: 1,
    title: 'Hello',
    slug: 'hello',
    body_markdown: 'Body text\n',
    description: null,
    web_visibility: 'listed',
    hero_image: null,
    form_id: null,
    subject: null,
    preheader: null,
    date: null,
    ...overrides,
  };
}

function baselineFor(r, local) {
  return { slug: r.slug, hash: remoteHash(r), fields: localFieldHashes(local), syncedAt: '2026-10-01T00:00:00.000Z' };
}

function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'posts-sync-test-'));
}

// ---------------------------------------------------------------------------
// Normalization
// ---------------------------------------------------------------------------

describe('remoteModel / localModel normalization', () => {
  test('body: CRLF, trailing whitespace and leading blank lines are ignored', () => {
    const local = localModel(payload({ body_markdown: '\n\r\nBody\r\ntext  \r\n\n' }));
    const remote = remoteModel(row({ body_markdown: 'Body\ntext' }));
    assert.equal(local.body_markdown, 'Body\ntext');
    assert.equal(remote.body_markdown, 'Body\ntext');
  });

  test('title is trimmed; subject empty or null defaults to the title', () => {
    assert.equal(localModel(payload({ title: '  Hi  ', subject: '' })).subject, 'Hi');
    assert.equal(remoteModel(row({ title: 'Hi', subject: null })).subject, 'Hi');
    assert.equal(localModel(payload({ subject: 'Other' })).subject, 'Other');
  });

  test('empty strings become null for optional fields', () => {
    const m = localModel(payload({ description: '', hero_image: '', preheader: '', form_id: '' }));
    assert.equal(m.description, null);
    assert.equal(m.hero_image, null);
    assert.equal(m.preheader, null);
    assert.equal(m.form_id, null);
  });

  test('visibility defaults to listed', () => {
    assert.equal(remoteModel(row({ web_visibility: null })).web_visibility, 'listed');
    assert.equal(localModel(payload({ web_visibility: 'none' })).web_visibility, 'none');
  });

  test('local email_enabled follows form_id; remote reads the column', () => {
    assert.equal(localModel(payload({ form_id: 'f1' })).email_enabled, true);
    assert.equal(localModel(payload({ form_id: null })).email_enabled, false);
    assert.equal(remoteModel(row({ email_enabled: true })).email_enabled, true);
    assert.equal(remoteModel(row({ email_enabled: null })).email_enabled, false);
  });

  test('remote date_override is normalized to an ISO instant', () => {
    assert.equal(remoteModel(row({ date_override: '2026-03-15T00:00:00+00:00' })).date_override, '2026-03-15T00:00:00.000Z');
  });
});

// ---------------------------------------------------------------------------
// Dates (mirrors upsert-post / _shared/post-date.ts)
// ---------------------------------------------------------------------------

describe('dateWouldChange', () => {
  test('no local date only changes a row that holds a date_override', () => {
    assert.equal(dateWouldChange(null, row()), false);
    assert.equal(dateWouldChange(null, row({ date_override: '2026-03-15T00:00:00.000Z' })), true);
    assert.equal(dateWouldChange(null, row({ published_at: '2026-03-15T10:00:00.000Z' })), false);
  });

  test('published post: date-only matching the UTC day of published_at is a no-op', () => {
    const r = row({ published_at: '2026-07-07T23:30:00.000Z' });
    assert.equal(dateWouldChange('2026-07-07', r), false);
    assert.equal(dateWouldChange('2026-07-08', r), true);
  });

  test('published post: a timestamp must match published_at exactly', () => {
    const r = row({ published_at: '2026-07-07T10:15:00+00:00' });
    assert.equal(dateWouldChange('2026-07-07T10:15:00.000Z', r), false);
    assert.equal(dateWouldChange('2026-07-07T10:16:00.000Z', r), true);
  });

  test('draft: the date is compared with date_override as an instant', () => {
    assert.equal(dateWouldChange('2026-03-15', row({ date_override: '2026-03-15T00:00:00.000Z' })), false);
    assert.equal(dateWouldChange('2026-03-15', row({ date_override: '2026-03-15T09:30:00.000Z' })), true);
    assert.equal(dateWouldChange('2026-03-15T09:30:00.000Z', row({ date_override: '2026-03-15T09:30:00+00:00' })), false);
    assert.equal(dateWouldChange('2026-03-15', row()), true);
  });
});

describe('diffFields', () => {
  test('identical post (after normalization) has no changes', () => {
    assert.deepEqual(diffFields(localModel(payload()), row()), []);
  });

  test('reports each changed field, date last', () => {
    const local = localModel(payload({ body_markdown: 'New', hero_image: 'https://x/h.png', date: '2026-01-01' }));
    assert.deepEqual(diffFields(local, row()), ['body_markdown', 'hero_image', 'date']);
    assert.deepEqual(fieldLabels(['body_markdown', 'hero_image', 'form_id', 'preheader', 'date']), [
      'body',
      'hero',
      'list',
      'preview',
      'date',
    ]);
  });

  test('a list on a row with email disabled counts as a change', () => {
    const local = localModel(payload({ form_id: 'f1' }));
    assert.deepEqual(diffFields(local, row({ form_id: 'f1', email_enabled: false })), ['email_enabled']);
    assert.deepEqual(diffFields(local, row({ form_id: 'f1', email_enabled: true })), []);
  });

  test('every single field change is detected', () => {
    const cases = {
      title: { title: 'Other' },
      description: { description: 'd' },
      web_visibility: { web_visibility: 'unlisted' },
      subject: { subject: 'S' },
      preheader: { preheader: 'p' },
    };
    for (const [field, over] of Object.entries(cases)) {
      const changed = diffFields(localModel(payload(over)), row());
      assert.ok(changed.includes(field), `${field} should be reported`);
    }
  });
});

// ---------------------------------------------------------------------------
// Remote hash
// ---------------------------------------------------------------------------

describe('remoteHash', () => {
  test('is versioned and stable regardless of row key order', () => {
    const a = row();
    const b = Object.fromEntries(Object.entries(row()).reverse());
    assert.match(remoteHash(a), /^v1:[0-9a-f]{64}$/);
    assert.equal(remoteHash(a), remoteHash(b));
  });

  test('ignores published_at and normalization-only differences', () => {
    assert.equal(remoteHash(row()), remoteHash(row({ published_at: '2026-01-01T00:00:00Z', body_markdown: 'Body text\r\n' })));
  });

  test('changes with date_override and with content', () => {
    assert.notEqual(remoteHash(row()), remoteHash(row({ date_override: '2026-01-01T00:00:00Z' })));
    assert.notEqual(remoteHash(row()), remoteHash(row({ body_markdown: 'x' })));
    assert.notEqual(remoteHash(row()), remoteHash(row({ email_enabled: true })));
  });
});

// ---------------------------------------------------------------------------
// classify: one test per behavior-table row
// ---------------------------------------------------------------------------

describe('classify', () => {
  test('no remote, no baseline -> created', () => {
    const r = classify({ local: localModel(payload()), remote: null, baseline: null, baselineRemote: null });
    assert.equal(r.state, 'created');
  });

  test('no remote, baseline whose post is gone -> deleted-remotely', () => {
    const local = localModel(payload());
    const r = classify({ local, remote: null, baseline: baselineFor(row(), local), baselineRemote: null });
    assert.equal(r.state, 'deleted-remotely');
  });

  test('no remote with this slug, baseline post now has another slug -> renamed-remotely', () => {
    const local = localModel(payload());
    const r = classify({
      local,
      remote: null,
      baseline: baselineFor(row(), local),
      baselineRemote: row({ slug: 'hello-again' }),
    });
    assert.equal(r.state, 'renamed-remotely');
    assert.equal(r.renamedTo, 'hello-again');
  });

  test('local equals remote -> unchanged (with or without baseline)', () => {
    const local = localModel(payload());
    assert.equal(classify({ local, remote: row(), baseline: null }).state, 'unchanged');
    const stale = baselineFor(row({ body_markdown: 'old' }), localModel(payload({ body_markdown: 'old' })));
    assert.equal(classify({ local, remote: row(), baseline: stale }).state, 'unchanged');
  });

  test('local changed, remote matches baseline -> updated', () => {
    const synced = localModel(payload());
    const local = localModel(payload({ body_markdown: 'Edited' }));
    const r = classify({ local, remote: row(), baseline: baselineFor(row(), synced) });
    assert.equal(r.state, 'updated');
    assert.deepEqual(r.fields, ['body_markdown']);
    assert.equal(r.noBaseline, undefined);
  });

  test('local differs, no baseline -> updated, flagged as unchecked', () => {
    const r = classify({ local: localModel(payload({ title: 'New' })), remote: row(), baseline: null });
    assert.equal(r.state, 'updated');
    assert.equal(r.noBaseline, true);
  });

  test('remote changed since baseline, local unchanged -> behind', () => {
    const synced = localModel(payload());
    const baseline = baselineFor(row(), synced);
    const r = classify({ local: synced, remote: row({ body_markdown: 'Edited in the editor' }), baseline });
    assert.equal(r.state, 'behind');
  });

  test('both changed since baseline -> conflict', () => {
    const synced = localModel(payload());
    const baseline = baselineFor(row(), synced);
    const r = classify({
      local: localModel(payload({ body_markdown: 'Local edit' })),
      remote: row({ body_markdown: 'Remote edit' }),
      baseline,
    });
    assert.equal(r.state, 'conflict');
  });

  test('a pulled published post (date-only local, timed published_at) stays unchanged', () => {
    const remote = row({ published_at: '2026-07-07T10:15:00.000Z' });
    const local = localModel(payload({ date: '2026-07-07' }));
    assert.equal(classify({ local, remote, baseline: baselineFor(remote, local) }).state, 'unchanged');
  });

  test('a baseline without field hashes counts as locally changed', () => {
    const local = localModel(payload());
    const r = classify({
      local,
      remote: row({ body_markdown: 'Remote edit' }),
      baseline: { slug: 'hello', hash: remoteHash(row()) },
    });
    assert.equal(r.state, 'conflict');
  });
});

// ---------------------------------------------------------------------------
// Sync state file
// ---------------------------------------------------------------------------

describe('sync state file', () => {
  let dir;
  beforeEach(() => {
    dir = tmpDir();
  });
  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  test('missing file loads as an empty state for the project', () => {
    assert.deepEqual(loadSyncState(dir, 7), { version: 1, projectId: 7, posts: {} });
  });

  test('round-trips, with no temp file left behind', () => {
    const state = loadSyncState(dir, 7);
    recordSynced(state, row(), localModel(payload()), new Date('2026-10-08T00:00:00Z'));
    saveSyncState(dir, state);

    const loaded = loadSyncState(dir, 7);
    assert.equal(loaded.posts.p1.slug, 'hello');
    assert.equal(loaded.posts.p1.hash, remoteHash(row()));
    assert.equal(loaded.posts.p1.syncedAt, '2026-10-08T00:00:00.000Z');
    assert.deepEqual(loaded.posts.p1.fields, localFieldHashes(localModel(payload())));
    assert.deepEqual(fs.readdirSync(path.join(dir, '.micropage')), ['posts-sync.json']);
  });

  test('a file for another project is ignored', () => {
    const state = loadSyncState(dir, 7);
    recordSynced(state, row(), localModel(payload()));
    saveSyncState(dir, state);
    assert.deepEqual(loadSyncState(dir, 8).posts, {});
    assert.ok(loadSyncState(dir, '7').posts.p1, 'string and number project ids are the same project');
  });

  test('a corrupt or wrong-version file is ignored', () => {
    fs.mkdirSync(path.join(dir, '.micropage'));
    fs.writeFileSync(path.join(dir, SYNC_STATE_FILE), '{not json');
    assert.deepEqual(loadSyncState(dir, 7).posts, {});
    fs.writeFileSync(path.join(dir, SYNC_STATE_FILE), JSON.stringify({ version: 2, projectId: 7, posts: { a: {} } }));
    assert.deepEqual(loadSyncState(dir, 7).posts, {});
  });

  test('recordSynced replaces an older entry for the same slug', () => {
    const state = loadSyncState(dir, 7);
    recordSynced(state, row({ id: 'old' }), localModel(payload()));
    recordSynced(state, row({ id: 'new' }), localModel(payload()));
    assert.deepEqual(Object.keys(state.posts), ['new']);
    assert.equal(findBaselineBySlug(state, 'hello').id, 'new');
    assert.equal(findBaselineBySlug(state, 'nope'), null);
  });
});

// ---------------------------------------------------------------------------
// posts-assets lookup mode
// ---------------------------------------------------------------------------

describe('image resolution lookup mode', () => {
  let dir;
  let calls;
  const saved = {};

  beforeEach(() => {
    dir = tmpDir();
    fs.mkdirSync(path.join(dir, 'posts'));
    fs.writeFileSync(path.join(dir, 'posts', 'hello.md'), '---\ntitle: Hello\n---\n');
    fs.writeFileSync(path.join(dir, 'posts', 'new.png'), 'new-bytes');
    fs.writeFileSync(path.join(dir, 'posts', 'old.png'), 'old-bytes');
    calls = { getUrl: 0, upload: 0 };
    saved.invokeGet = supabase.fn.invokeGet;
    saved.upload = supabase.uploadAssetWithToken;
    supabase.fn.invokeGet = async (name, params) => {
      assert.equal(name, 'get-file-url');
      calls.getUrl += 1;
      return { url: `https://files.example/${params.file_id}.png` };
    };
    supabase.uploadAssetWithToken = async () => {
      calls.upload += 1;
      return { file: { id: 'uploaded', filename: 'new.png', content_hash: supabase.hashFile(path.join(dir, 'posts', 'new.png')) } };
    };
  });

  afterEach(() => {
    supabase.fn.invokeGet = saved.invokeGet;
    supabase.uploadAssetWithToken = saved.upload;
    fs.rmSync(dir, { recursive: true, force: true });
  });

  function fileIndex() {
    const oldHash = supabase.hashFile(path.join(dir, 'posts', 'old.png'));
    const existing = { id: 'f-old', filename: 'old.png', content_hash: oldHash };
    return { byFilename: new Map([['old.png', existing]]), byHash: new Map([[oldHash, existing]]), urlById: new Map() };
  }

  test('body: uploaded images resolve, new ones are pending and not uploaded', async () => {
    const idx = fileIndex();
    const result = await resolveBodyImages({
      accessToken: 't',
      projectId: 1,
      postFilePath: path.join(dir, 'posts', 'hello.md'),
      cwd: dir,
      body: '![a](old.png)\n\n![b](new.png)\n\n![c](old.png)',
      fileIndex: idx,
      upload: false,
    });
    assert.equal(calls.upload, 0);
    assert.equal(calls.getUrl, 1);
    assert.deepEqual(result.pendingUploads, ['new.png']);
    assert.match(result.markdown, /!\[a\]\(https:\/\/files\.example\/f-old\.png\)/);
    assert.match(result.markdown, /!\[b\]\(pending-upload:[0-9a-f]{64}\)/);
  });

  test('hero: pending in lookup mode, uploaded otherwise; URLs are memoized per index', async () => {
    const idx = fileIndex();
    const args = {
      accessToken: 't',
      projectId: 1,
      postFilePath: path.join(dir, 'posts', 'hello.md'),
      cwd: dir,
      heroFrontMatter: 'new.png',
      fileIndex: idx,
    };
    const lookup = await resolveHeroImage({ ...args, upload: false });
    assert.deepEqual(lookup.pendingUploads, ['new.png']);
    assert.match(lookup.url, /^pending-upload:/);
    assert.equal(calls.upload, 0);

    const real = await resolveHeroImage({ ...args, upload: true });
    assert.equal(calls.upload, 1);
    assert.equal(real.url, 'https://files.example/uploaded.png');
    assert.deepEqual(real.pendingUploads, []);

    await resolveHeroImage({ ...args, heroFrontMatter: 'old.png', upload: false });
    await resolveHeroImage({ ...args, heroFrontMatter: 'old.png', upload: false });
    assert.equal(calls.getUrl, 2, 'old.png resolved once, uploaded.png once');
  });
});

// ---------------------------------------------------------------------------
// push / pull / publish against an in-memory fake of the Supabase API
// ---------------------------------------------------------------------------

class ExitCalled extends Error {
  constructor(code) {
    super(`process.exit(${code})`);
    this.code = code;
  }
}

function makeFakeServer() {
  const server = {
    posts: [],
    forms: [{ id: 'form-1', project_id: 1, form_name: 'Newsletter', is_newsletter: true }],
    invocations: [],
    nextId: 1,
  };

  const matches = (r, filters) =>
    filters.every(([kind, col, val]) => (kind === 'in' ? val.includes(String(r[col])) : String(r[col]) === String(val)));

  server.db = {
    from(table) {
      const filters = [];
      const q = {
        select() { return q; },
        eq(col, val) { filters.push(['eq', col, val]); return q; },
        in(col, vals) { filters.push(['in', col, vals.map(String)]); return q; },
        order() { return q; },
        limit() { return q; },
        async get() {
          if (table === 'posts') return server.posts.filter((r) => matches(r, filters)).map((r) => ({ ...r }));
          if (table === 'forms') return server.forms.filter((r) => matches(r, filters)).map((r) => ({ ...r }));
          if (table === 'projects') return [{ id: 1, active_build_id: null }];
          throw new Error(`unexpected table ${table}`);
        },
        async single() { return (await q.get())[0] || null; },
      };
      return q;
    },
  };

  // Mirrors upsert-post's stored shape closely enough for change detection.
  server.fn = {
    async invoke(name, body) {
      server.invocations.push({ name, body });
      if (name === 'upsert-post') {
        let post = server.posts.find((p) => p.slug === body.slug);
        const action = post ? 'updated' : 'created';
        if (!post) {
          post = { id: `post-${server.nextId++}`, project_id: body.project_id, published_at: null, date_override: null };
          server.posts.push(post);
        }
        Object.assign(post, {
          slug: body.slug,
          title: body.title,
          body_markdown: body.body_markdown,
          description: body.description || null,
          web_visibility: body.web_visibility || 'listed',
          hero_image: body.hero_image || null,
          form_id: body.form_id || null,
          email_enabled: body.form_id != null,
          subject: body.subject || body.title,
          preheader: body.preheader || null,
        });
        if (body.date === null) post.date_override = null;
        else if (body.date && !dateWouldChange(body.date, post)) {
          // no-op
        } else if (body.date) {
          const iso = new Date(/^\d{4}-\d{2}-\d{2}$/.test(body.date) ? `${body.date}T00:00:00Z` : body.date).toISOString();
          post.date_override = iso;
          if (post.published_at) post.published_at = iso;
        }
        return { post_id: post.id, action, published: post.published_at != null, rebuild_build_id: null };
      }
      if (name === 'publish-post') {
        const post = server.posts.find((p) => p.slug === body.slug);
        if (!post.published_at) post.published_at = post.date_override || '2026-10-08T12:00:00.000Z';
        return { published_at: post.published_at, emailed: post.email_enabled, recipient_count: 3, rebuild_build_id: null };
      }
      throw new Error(`unexpected function ${name}`);
    },
    async invokeGet(name) {
      if (name === 'list-files') return { files: [] };
      throw new Error(`unexpected function ${name}`);
    },
  };
  return server;
}

describe('posts commands (stubbed API)', () => {
  let dir;
  let server;
  let out;
  let posts;
  const originalCwd = process.cwd();
  const saved = {};

  beforeEach(() => {
    dir = tmpDir();
    fs.mkdirSync(path.join(dir, '.micropage'));
    fs.writeFileSync(path.join(dir, '.micropage', 'project.json'), JSON.stringify({ projectId: 1 }));
    fs.mkdirSync(path.join(dir, 'posts'));
    process.chdir(dir);

    server = makeFakeServer();
    out = [];
    saved.db = supabase.db.from;
    saved.invoke = supabase.fn.invoke;
    saved.invokeGet = supabase.fn.invokeGet;
    saved.token = supabase.getValidAccessToken;
    saved.exit = process.exit;
    saved.log = console.log;
    saved.error = console.error;
    saved.warn = console.warn;
    saved.fetch = global.fetch;

    supabase.db.from = server.db.from;
    supabase.fn.invoke = server.fn.invoke;
    supabase.fn.invokeGet = server.fn.invokeGet;
    supabase.getValidAccessToken = async () => 'token';
    global.fetch = async () => {
      throw new Error('network access in tests');
    };
    process.exit = (code) => {
      throw new ExitCalled(code);
    };
    console.log = (...a) => out.push(a.join(' '));
    console.error = (...a) => out.push(a.join(' '));
    console.warn = (...a) => out.push(a.join(' '));

    // Loaded after the stubs: posts.js destructures getValidAccessToken at require time.
    delete require.cache[require.resolve('../src/commands/posts')];
    posts = require('../src/commands/posts');
  });

  afterEach(() => {
    supabase.db.from = saved.db;
    supabase.fn.invoke = saved.invoke;
    supabase.fn.invokeGet = saved.invokeGet;
    supabase.getValidAccessToken = saved.token;
    process.exit = saved.exit;
    console.log = saved.log;
    console.error = saved.error;
    console.warn = saved.warn;
    global.fetch = saved.fetch;
    process.chdir(originalCwd);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  function writePost(name, text) {
    fs.writeFileSync(path.join(dir, 'posts', name), text);
  }

  async function run(fnToRun) {
    out.length = 0;
    try {
      await fnToRun();
      return 0;
    } catch (err) {
      if (err instanceof ExitCalled) return err.code;
      throw err;
    }
  }

  const upserts = () => server.invocations.filter((i) => i.name === 'upsert-post');
  const line = (slug) => out.find((l) => l.includes(`"${slug}"`)) || '';

  test('first push creates; second push changes nothing', async () => {
    writePost('hello.md', '---\ntitle: Hello\n---\nBody\n');
    writePost('2026-01-01-launch.md', '---\ntitle: Launch\n---\n\nLaunch body\n');

    assert.equal(await run(() => posts.push([], {})), 0);
    assert.equal(upserts().length, 2);
    assert.match(line('hello'), /created, saved \(draft\)/);
    assert.ok(out.includes('2 created, 0 updated, 0 unchanged, 0 skipped, 0 conflict, 0 failed.'));
    const state = JSON.parse(fs.readFileSync(path.join(dir, SYNC_STATE_FILE), 'utf8'));
    assert.equal(Object.keys(state.posts).length, 2);

    assert.equal(await run(() => posts.push([], {})), 0);
    assert.equal(upserts().length, 2, 'no writes for unchanged posts');
    assert.match(line('launch'), /: unchanged$/);
  });

  test('local edit is pushed with the changed fields named', async () => {
    writePost('hello.md', '---\ntitle: Hello\n---\nBody\n');
    await run(() => posts.push([], {}));
    writePost('hello.md', '---\ntitle: Hello\ndescription: Short\n---\nBody edited\n');

    assert.equal(await run(() => posts.push([], {})), 0);
    assert.match(line('hello'), /updated \(body, description\), saved \(draft\)/);
  });

  test('remote edit since the last sync is not overwritten', async () => {
    writePost('hello.md', '---\ntitle: Hello\n---\nBody\n');
    await run(() => posts.push([], {}));
    server.posts[0].body_markdown = 'Edited in the editor';

    assert.equal(await run(() => posts.push([], {})), 0);
    assert.match(line('hello'), /skipped, remote changed since last sync/);
    assert.equal(upserts().length, 1);
    assert.equal(server.posts[0].body_markdown, 'Edited in the editor');
  });

  test('conflict exits 1 unless --force', async () => {
    writePost('hello.md', '---\ntitle: Hello\n---\nBody\n');
    await run(() => posts.push([], {}));
    server.posts[0].body_markdown = 'Remote edit';
    writePost('hello.md', '---\ntitle: Hello\n---\nLocal edit\n');

    assert.equal(await run(() => posts.push([], {})), 1);
    assert.match(line('hello'), /CONFLICT/);
    assert.equal(server.posts[0].body_markdown, 'Remote edit');

    assert.equal(await run(() => posts.push(['hello'], { force: true })), 0);
    assert.match(line('hello'), /updated \(body; overwrote remote changes\)/);
    assert.equal(server.posts[0].body_markdown, 'Local edit\n');

    assert.equal(await run(() => posts.push([], {})), 0);
    assert.match(line('hello'), /: unchanged$/);
  });

  test('--dry-run reports without writing posts or the sync state', async () => {
    writePost('hello.md', '---\ntitle: Hello\n---\nBody\n');
    fs.writeFileSync(path.join(dir, 'posts', 'hello.png'), 'png-bytes');

    assert.equal(await run(() => posts.push([], { dryRun: true })), 0);
    assert.match(line('hello'), /would be created, would upload 1 image\(s\)/);
    assert.equal(upserts().length, 0);
    assert.equal(fs.existsSync(path.join(dir, SYNC_STATE_FILE)), false);
    assert.ok(out.some((l) => l.startsWith('Dry run, nothing written: 1 created')));
  });

  test('no baseline: a differing remote post is updated and flagged as unchecked', async () => {
    writePost('hello.md', '---\ntitle: Hello\n---\nBody\n');
    await run(() => posts.push([], {}));
    fs.rmSync(path.join(dir, SYNC_STATE_FILE));
    server.posts[0].body_markdown = 'Remote edit';

    assert.equal(await run(() => posts.push([], {})), 0);
    assert.match(line('hello'), /updated \(body; no sync record, remote edits not checked\)/);
  });

  test('deleted remotely exits 1; --force recreates it', async () => {
    writePost('hello.md', '---\ntitle: Hello\n---\nBody\n');
    await run(() => posts.push([], {}));
    server.posts = [];

    assert.equal(await run(() => posts.push([], {})), 1);
    assert.match(line('hello'), /skipped, deleted remotely since last sync/);
    assert.equal(server.posts.length, 0);

    assert.equal(await run(() => posts.push([], { force: true })), 0);
    assert.match(line('hello'), /created \(was deleted remotely\)/);
    assert.equal(server.posts.length, 1);
  });

  test('renamed remotely exits 1 and names the new slug', async () => {
    writePost('hello.md', '---\ntitle: Hello\n---\nBody\n');
    await run(() => posts.push([], {}));
    server.posts[0].slug = 'hello-world';

    assert.equal(await run(() => posts.push([], {})), 1);
    assert.match(line('hello'), /renamed remotely to "hello-world"/);
  });

  test('slug arguments limit the push; an unknown slug fails', async () => {
    writePost('a.md', '---\ntitle: A\n---\nA\n');
    writePost('b.md', '---\ntitle: B\n---\nB\n');

    assert.equal(await run(() => posts.push(['a'], {})), 0);
    assert.deepEqual(upserts().map((u) => u.body.slug), ['a']);

    assert.equal(await run(() => posts.push(['nope'], {})), 1);
    assert.match(line('nope'), /no post file/);
  });

  test('visibility: none is accepted', async () => {
    writePost('quiet.md', '---\ntitle: Quiet\nvisibility: none\n---\nBody\n');
    assert.equal(await run(() => posts.push([], {})), 0);
    assert.equal(server.posts[0].web_visibility, 'none');
  });

  test('a pulled email post pushes back unchanged and pull leaves it alone', async () => {
    server.posts.push({
      id: 'post-9',
      project_id: 1,
      slug: 'news',
      title: 'News',
      description: null,
      body_markdown: 'Hello subscribers',
      web_visibility: 'unlisted',
      hero_image: 'https://files.example/h.png',
      form_id: 'form-1',
      email_enabled: true,
      subject: 'Big news',
      preheader: 'Read this',
      published_at: '2026-07-07T10:15:00.000Z',
      date_override: null,
      status: 'sent',
      created_at: '2026-07-01T00:00:00.000Z',
    });

    assert.equal(await run(() => posts.pull([], {})), 0);
    const text = fs.readFileSync(path.join(dir, 'posts', 'news.md'), 'utf8');
    assert.match(text, /list: Newsletter/);
    assert.match(text, /subject: Big news/);
    assert.match(text, /preview: Read this/);

    assert.equal(await run(() => posts.push([], {})), 0);
    assert.match(line('news'), /: unchanged$/);
    assert.equal(upserts().length, 0);

    // Existing file already matches: no overwrite prompt.
    assert.equal(await run(() => posts.pull(['news'], {})), 0);
    assert.ok(out.some((l) => l === 'posts/news.md: unchanged'));
  });

  test('publish without a slug skips live posts; a live email post needs --resend', async () => {
    writePost('draft.md', '---\ntitle: Draft\n---\nBody\n');
    writePost('news.md', '---\ntitle: News\nemail: true\nlist: Newsletter\n---\nBody\n');
    await run(() => posts.push([], {}));
    server.posts.find((p) => p.slug === 'news').published_at = '2026-07-07T10:15:00.000Z';
    const publishes = () => server.invocations.filter((i) => i.name === 'publish-post').map((i) => i.body.slug);

    assert.equal(await run(() => posts.publish(undefined, {})), 0);
    assert.deepEqual(publishes(), ['draft']);
    assert.match(line('news'), /already live, skipped \(no email re-sent\)/);

    assert.equal(await run(() => posts.publish('news', {})), 1);
    assert.match(line('news'), /--resend/);
    assert.deepEqual(publishes(), ['draft']);

    assert.equal(await run(() => posts.publish('news', { resend: true })), 0);
    assert.deepEqual(publishes(), ['draft', 'news']);
  });

  test('publish by slug: a live web-only post republishes without --resend; a draft email post publishes', async () => {
    writePost('web.md', '---\ntitle: Web\n---\nBody\n');
    writePost('news.md', '---\ntitle: News\nemail: true\nlist: Newsletter\n---\nBody\n');
    await run(() => posts.push([], {}));
    server.posts.find((p) => p.slug === 'web').published_at = '2026-07-07T10:15:00.000Z';
    const publishes = () => server.invocations.filter((i) => i.name === 'publish-post').map((i) => i.body.slug);

    assert.equal(await run(() => posts.publish(undefined, {})), 0);
    assert.match(line('web'), /already live, skipped$/);
    assert.deepEqual(publishes(), ['news'], 'no-slug publish only publishes drafts');

    assert.equal(await run(() => posts.publish('web', {})), 0);
    assert.deepEqual(publishes(), ['news', 'web']);

    // Now live with email: neither the no-slug form nor the slug form re-sends.
    assert.equal(await run(() => posts.publish(undefined, {})), 0);
    assert.equal(await run(() => posts.publish('news', {})), 1);
    assert.deepEqual(publishes(), ['news', 'web']);
  });

  test('--dry-run leaves an existing sync file byte-for-byte and uploads nothing', async () => {
    writePost('a.md', '---\ntitle: A\n---\nA\n');
    writePost('b.md', '---\ntitle: B\n---\nB\n');
    await run(() => posts.push([], {}));
    const statePath = path.join(dir, SYNC_STATE_FILE);
    const before = fs.readFileSync(statePath, 'utf8');
    writePost('a.md', '---\ntitle: A\n---\nA edited\n');
    fs.writeFileSync(path.join(dir, 'posts', 'a.png'), 'png-bytes');
    server.posts.find((p) => p.slug === 'b').body_markdown = 'B remote';
    let uploads = 0;
    const savedUpload = supabase.uploadAssetWithToken;
    supabase.uploadAssetWithToken = async () => {
      uploads += 1;
      throw new Error('upload in dry run');
    };
    try {
      assert.equal(await run(() => posts.push([], { dryRun: true })), 0);
    } finally {
      supabase.uploadAssetWithToken = savedUpload;
    }
    assert.match(line('a'), /would be updated \(body, hero\), would upload 1 image\(s\)/);
    assert.match(line('b'), /skipped, remote changed since last sync/);
    assert.equal(upserts().length, 2, 'only the first real push wrote');
    assert.equal(uploads, 0);
    assert.equal(fs.readFileSync(statePath, 'utf8'), before);
    assert.deepEqual(fs.readdirSync(path.join(dir, '.micropage')).sort(), ['posts-sync.json', 'project.json']);
  });

  test('pull writes a baseline, so a later remote edit is detected as behind', async () => {
    server.posts.push({
      id: 'post-7', project_id: 1, slug: 'hello', title: 'Hello', description: null, body_markdown: 'Body',
      web_visibility: 'listed', hero_image: null, form_id: null, email_enabled: false, subject: 'Hello',
      preheader: null, published_at: null, date_override: '2026-05-01T09:30:00.000Z', status: 'draft',
      created_at: '2026-05-01T00:00:00.000Z',
    });
    assert.equal(await run(() => posts.pull([], {})), 0);
    const state = JSON.parse(fs.readFileSync(path.join(dir, SYNC_STATE_FILE), 'utf8'));
    assert.equal(state.projectId, 1);
    assert.equal(state.posts['post-7'].slug, 'hello');
    assert.equal(state.posts['post-7'].hash, remoteHash(server.posts[0]));

    // The pulled draft (held timed date included) pushes back unchanged.
    assert.equal(await run(() => posts.push([], {})), 0);
    assert.match(line('hello'), /: unchanged$/);

    server.posts[0].title = 'Hello again';
    assert.equal(await run(() => posts.push([], {})), 0);
    assert.match(line('hello'), /skipped, remote changed since last sync/);
    assert.equal(upserts().length, 0);
  });

  test('push records the server row as the baseline, and an unchanged post backfills one', async () => {
    writePost('hello.md', '---\ntitle: Hello\n---\nBody\n');
    writePost('same.md', '---\ntitle: Same\n---\nSame body\n');
    server.posts.push({
      id: 'post-50', project_id: 1, slug: 'same', title: 'Same', description: null, body_markdown: 'Same body',
      web_visibility: 'listed', hero_image: null, form_id: null, email_enabled: false, subject: 'Same',
      preheader: null, published_at: null, date_override: null,
    });

    assert.equal(await run(() => posts.push([], {})), 0);
    const state = JSON.parse(fs.readFileSync(path.join(dir, SYNC_STATE_FILE), 'utf8'));
    const created = server.posts.find((p) => p.slug === 'hello');
    assert.equal(state.posts[created.id].hash, remoteHash(created));
    assert.equal(state.posts['post-50'].hash, remoteHash(server.posts.find((p) => p.slug === 'same')));
    assert.match(line('same'), /: unchanged$/);
  });

  test('a sync file for another project is ignored and replaced', async () => {
    writePost('hello.md', '---\ntitle: Hello\n---\nBody\n');
    await run(() => posts.push([], {}));
    const statePath = path.join(dir, SYNC_STATE_FILE);
    const state = JSON.parse(fs.readFileSync(statePath, 'utf8'));
    state.projectId = 2;
    fs.writeFileSync(statePath, JSON.stringify(state));
    server.posts[0].body_markdown = 'Remote edit';

    // With the baseline ignored, the remote edit can't be detected: lenient overwrite.
    assert.equal(await run(() => posts.push([], {})), 0);
    assert.match(line('hello'), /updated \(body; no sync record, remote edits not checked\)/);
    assert.equal(server.posts[0].body_markdown, 'Body\n');
    assert.equal(JSON.parse(fs.readFileSync(statePath, 'utf8')).projectId, 1);
  });

  test('a remote edit between upsert and read-back is not recorded as synced', async () => {
    writePost('hello.md', '---\ntitle: Hello\n---\nBody\n');
    const upsert = server.fn.invoke;
    supabase.fn.invoke = async (name, body) => {
      const result = await upsert(name, body);
      if (name === 'upsert-post') server.posts[0].body_markdown = 'Edited in the editor meanwhile';
      return result;
    };
    assert.equal(await run(() => posts.push([], {})), 0);
    const state = JSON.parse(fs.readFileSync(path.join(dir, SYNC_STATE_FILE), 'utf8'));
    assert.notEqual(state.posts[server.posts[0].id].hash, remoteHash(server.posts[0]));
    supabase.fn.invoke = upsert;

    assert.equal(await run(() => posts.push([], {})), 0);
    assert.match(line('hello'), /skipped, remote changed since last sync/);
    assert.equal(server.posts[0].body_markdown, 'Edited in the editor meanwhile');

    writePost('hello.md', '---\ntitle: Hello\n---\nLocal edit\n');
    assert.equal(await run(() => posts.push([], {})), 1);
    assert.match(line('hello'), /CONFLICT/);
  });

  test('a failed read-back leaves the pushed post unconfirmed and warns', async () => {
    writePost('hello.md', '---\ntitle: Hello\n---\nBody\n');
    const from = server.db.from;
    let postsReads = 0;
    supabase.db.from = (table) => {
      const q = from(table);
      if (table !== 'posts') return q;
      postsReads += 1;
      if (postsReads === 2) q.get = async () => { throw new Error('connection reset'); };
      return q;
    };
    assert.equal(await run(() => posts.push([], {})), 0);
    assert.ok(out.some((l) => /could not read back the pushed posts \(connection reset\)/.test(l)));
    const state = JSON.parse(fs.readFileSync(path.join(dir, SYNC_STATE_FILE), 'utf8'));
    const entry = state.posts[server.posts[0].id];
    assert.ok(entry, 'entry kept so the next push still checks for remote edits');
    assert.notEqual(entry.hash, remoteHash(server.posts[0]));
    supabase.db.from = from;

    // The remote still matches the file, so the next push confirms it.
    assert.equal(await run(() => posts.push([], {})), 0);
    assert.match(line('hello'), /: unchanged$/);
    const confirmed = JSON.parse(fs.readFileSync(path.join(dir, SYNC_STATE_FILE), 'utf8'));
    assert.equal(confirmed.posts[server.posts[0].id].hash, remoteHash(server.posts[0]));
  });

  test('a failed upsert mid-push still records the posts that were saved, and exits 1', async () => {
    writePost('a.md', '---\ntitle: A\n---\nA\n');
    writePost('b.md', '---\ntitle: B\n---\nB\n');
    const upsert = server.fn.invoke;
    supabase.fn.invoke = async (name, body) => {
      if (name === 'upsert-post' && body.slug === 'b') {
        const err = new Error('boom');
        err.status = 500;
        throw err;
      }
      return upsert(name, body);
    };
    assert.equal(await run(() => posts.push([], {})), 1);
    assert.match(line('b') || out.join('\n'), /upsert failed \(boom\)/);
    assert.ok(out.includes('1 created, 0 updated, 0 unchanged, 0 skipped, 0 conflict, 1 failed.'));
    const state = JSON.parse(fs.readFileSync(path.join(dir, SYNC_STATE_FILE), 'utf8'));
    const a = server.posts.find((p) => p.slug === 'a');
    assert.equal(state.posts[a.id].hash, remoteHash(a));
    assert.equal(Object.keys(state.posts).length, 1);
  });

  test('with slug arguments, a matching file that fails to parse reports the parse error', async () => {
    writePost('broken.md', '---\ntitle: [unclosed\n---\nBody\n');
    assert.equal(await run(() => posts.push(['broken'], {})), 1);
    assert.ok(out.some((l) => /posts\/broken\.md: invalid front-matter/.test(l)));
    assert.ok(!out.some((l) => /no post file/.test(l)));
    assert.ok(out.includes('0 created, 0 updated, 0 unchanged, 0 skipped, 0 conflict, 1 failed.'));
  });

  test('--dry-run --force says the remote would be overwritten', async () => {
    writePost('hello.md', '---\ntitle: Hello\n---\nBody\n');
    await run(() => posts.push([], {}));
    server.posts[0].body_markdown = 'Remote edit';
    writePost('hello.md', '---\ntitle: Hello\n---\nLocal edit\n');

    assert.equal(await run(() => posts.push([], { force: true, dryRun: true })), 0);
    assert.match(line('hello'), /would be updated \(body; would overwrite remote changes\)/);
    assert.equal(server.posts[0].body_markdown, 'Remote edit');
  });

  test('an emailed post that was unpublished needs --resend; a web-only one republishes', async () => {
    writePost('news.md', '---\ntitle: News\nemail: true\nlist: Newsletter\n---\nBody\n');
    writePost('web.md', '---\ntitle: Web\n---\nBody\n');
    await run(() => posts.push([], {}));
    // Emailed, then unpublished: published_at cleared, send record kept.
    Object.assign(server.posts.find((p) => p.slug === 'news'), {
      published_at: null, status: 'sent', recipient_count: 3, sent_count: 3, started_at: '2026-07-07T10:16:00.000Z',
    });
    Object.assign(server.posts.find((p) => p.slug === 'web'), { status: 'queued', recipient_count: 0, sent_count: 0 });
    const publishes = () => server.invocations.filter((i) => i.name === 'publish-post').map((i) => i.body.slug);

    assert.equal(await run(() => posts.publish(undefined, {})), 0);
    assert.deepEqual(publishes(), ['web']);
    assert.match(line('news'), /already emailed, skipped \(no email re-sent; use "micropage posts publish news --resend"\)/);

    assert.equal(await run(() => posts.publish('news', {})), 1);
    assert.match(line('news'), /already emailed; .*--resend/);
    assert.deepEqual(publishes(), ['web']);

    assert.equal(await run(() => posts.publish('news', { resend: true })), 0);
    assert.deepEqual(publishes(), ['web', 'news']);
  });

  test('a queued but unsent email (recipients snapshotted) also counts as emailed', async () => {
    writePost('news.md', '---\ntitle: News\nemail: true\nlist: Newsletter\n---\nBody\n');
    await run(() => posts.push([], {}));
    Object.assign(server.posts[0], { status: 'queued', recipient_count: 2, sent_count: 0 });
    assert.equal(await run(() => posts.publish('news', {})), 1);
    assert.equal(server.invocations.filter((i) => i.name === 'publish-post').length, 0);
  });
});
