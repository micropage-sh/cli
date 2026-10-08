'use strict';
/**
 * Unit tests for the pure helpers in cli/src/commands/posts.js and
 * cli/src/posts-assets.js.
 *
 * Scope: string/data transforms only. Anything that talks to Supabase
 * (resolveHeroImage, resolveBodyImages' upload path) is out of scope here —
 * see the "Manual checks needed" note in the tester report for what's left
 * uncovered.
 */

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const matter = require('gray-matter');

const {
  slugify,
  defaultSlugFromFilename,
  frontMatterFromPost,
  rebuildTarget,
  normalizePostDate,
} = require('../src/commands/posts');
const { findCompanionImage } = require('../src/posts-assets');

// ---------------------------------------------------------------------------
// slugify
// ---------------------------------------------------------------------------

describe('slugify', () => {
  test('lowercases', () => {
    assert.equal(slugify('Hello World'), 'hello-world');
  });

  test('collapses runs of non-alphanumerics to a single hyphen', () => {
    assert.equal(slugify('Hello!!!   World??'), 'hello-world');
    assert.equal(slugify('a---b___c'), 'a-b-c');
  });

  test('trims leading/trailing hyphens', () => {
    assert.equal(slugify('--Hello World--'), 'hello-world');
    assert.equal(slugify('  spaced out  '), 'spaced-out');
  });

  test('empty-ish input produces empty string', () => {
    assert.equal(slugify(''), '');
    assert.equal(slugify('   '), '');
    assert.equal(slugify('!!!'), '');
  });
});

// ---------------------------------------------------------------------------
// defaultSlugFromFilename
// ---------------------------------------------------------------------------

describe('defaultSlugFromFilename', () => {
  test('strips a leading YYYY-MM-DD- date prefix and .md extension', () => {
    assert.equal(defaultSlugFromFilename('posts/2026-01-01-launch.md'), 'launch');
    assert.equal(defaultSlugFromFilename('2024-12-31-year-end-review.md'), 'year-end-review');
  });

  test('leaves non-prefixed names alone (minus .md)', () => {
    assert.equal(defaultSlugFromFilename('posts/hello-world.md'), 'hello-world');
    assert.equal(defaultSlugFromFilename('no-date-here.md'), 'no-date-here');
  });

  test('does not strip malformed dates', () => {
    // single-digit month/day, wrong separator, short year — none match \d{4}-\d{2}-\d{2}-
    assert.equal(defaultSlugFromFilename('2026-1-1-launch.md'), '2026-1-1-launch');
    assert.equal(defaultSlugFromFilename('26-01-01-launch.md'), '26-01-01-launch');
    assert.equal(defaultSlugFromFilename('2026_01_01_launch.md'), '2026_01_01_launch');
  });
});

// ---------------------------------------------------------------------------
// frontMatterFromPost -> gray-matter round-trip
// ---------------------------------------------------------------------------

describe('frontMatterFromPost', () => {
  test('minimal post: default visibility and subject==title are omitted', () => {
    const post = {
      title: 'Hello',
      slug: 'hello',
      web_visibility: 'listed',
      subject: 'Hello',
    };
    const fm = frontMatterFromPost(post);

    assert.equal(fm.visibility, undefined, 'default "listed" visibility should be omitted');
    assert.equal(fm.subject, undefined, 'subject === title should be omitted');

    const content = matter.stringify('body text', fm);
    const parsed = matter(content);
    assert.equal(parsed.data.title, 'Hello');
    assert.equal(parsed.data.slug, 'hello');
    assert.equal(parsed.data.visibility, undefined);
    assert.equal(parsed.data.subject, undefined);
    assert.equal(parsed.content.trim(), 'body text');
  });

  test('email_enabled: false omits the "email" key entirely', () => {
    const post = { title: 'No Email', email_enabled: false };
    const fm = frontMatterFromPost(post);
    assert.equal(fm.email, undefined);

    const parsed = matter(matter.stringify('body', fm));
    assert.equal(parsed.data.email, undefined);
  });

  test('email_enabled: true sets email: true', () => {
    const post = { title: 'Emailed', email_enabled: true };
    const fm = frontMatterFromPost(post);
    assert.equal(fm.email, true);

    const parsed = matter(matter.stringify('body', fm));
    assert.equal(parsed.data.email, true);
  });

  test('email post writes list: from the form name map, so push can keep emailing it', () => {
    const post = { title: 'Emailed', email_enabled: true, form_id: 'form-1', subject: 'Emailed' };
    const fm = frontMatterFromPost(post, new Map([['form-1', 'Newsletter']]));
    assert.equal(fm.email, true);
    assert.equal(fm.list, 'Newsletter');
    assert.equal(matter(matter.stringify('body', fm)).data.list, 'Newsletter');
  });

  test('list: is omitted when the form is unknown or email is off', () => {
    assert.equal(frontMatterFromPost({ title: 'E', email_enabled: true, form_id: 'gone' }, new Map()).list, undefined);
    const off = frontMatterFromPost({ title: 'E', email_enabled: false, form_id: 'form-1' }, new Map([['form-1', 'Newsletter']]));
    assert.equal(off.list, undefined);
    assert.equal(off.email, undefined);
  });

  test('visibility none round-trips', () => {
    const fm = frontMatterFromPost({ title: 'Email only', web_visibility: 'none' });
    assert.equal(matter(matter.stringify('body', fm)).data.visibility, 'none');
  });

  test('hero, description, preview (from preheader) survive the round-trip', () => {
    const post = {
      title: 'Full Post',
      slug: 'full-post',
      description: 'A description',
      web_visibility: 'unlisted',
      hero_image: 'https://cdn.example.com/hero.png',
      email_enabled: true,
      subject: 'A different subject',
      preheader: 'A preview line',
    };
    const fm = frontMatterFromPost(post);

    assert.equal(fm.description, 'A description');
    assert.equal(fm.visibility, 'unlisted');
    assert.equal(fm.hero, 'https://cdn.example.com/hero.png');
    assert.equal(fm.email, true);
    assert.equal(fm.subject, 'A different subject');
    assert.equal(fm.preview, 'A preview line');

    const parsed = matter(matter.stringify('body content here', fm));
    assert.equal(parsed.data.title, 'Full Post');
    assert.equal(parsed.data.slug, 'full-post');
    assert.equal(parsed.data.description, 'A description');
    assert.equal(parsed.data.visibility, 'unlisted');
    assert.equal(parsed.data.hero, 'https://cdn.example.com/hero.png');
    assert.equal(parsed.data.email, true);
    assert.equal(parsed.data.subject, 'A different subject');
    assert.equal(parsed.data.preview, 'A preview line');
    assert.equal(parsed.content.trim(), 'body content here');
  });

  test('published post writes date as the UTC calendar day of published_at', () => {
    const fm = frontMatterFromPost({ title: 'P', slug: 'p', published_at: '2026-07-07T23:30:00+00:00' });
    assert.equal(fm.date, '2026-07-07');
    const fm2 = frontMatterFromPost({ title: 'P', published_at: '2026-07-07T23:30:00-05:00' });
    assert.equal(fm2.date, '2026-07-08');
  });

  test('draft (no published_at) omits date', () => {
    const fm = frontMatterFromPost({ title: 'Draft', slug: 'draft', published_at: null });
    assert.equal(fm.date, undefined);
    assert.equal(matter(matter.stringify('body', fm)).data.date, undefined);
  });

  test('draft with a held date writes it, so pull then push keeps it', () => {
    const day = frontMatterFromPost({ title: 'D', slug: 'd', published_at: null, date_override: '2026-03-15T00:00:00.000Z' });
    assert.equal(day.date, '2026-03-15');
    const timed = frontMatterFromPost({ title: 'D', slug: 'd', published_at: null, date_override: '2026-03-15T09:30:00.000Z' });
    assert.equal(timed.date, '2026-03-15T09:30:00.000Z');
    assert.equal(normalizePostDate(matter(matter.stringify('body', timed)).data.date), '2026-03-15T09:30:00.000Z');
  });

  test('pulled date round-trips through push normalization unchanged', () => {
    const fm = frontMatterFromPost({ title: 'P', slug: 'p', published_at: '2026-07-07T10:15:00.000Z' });
    const parsed = matter(matter.stringify('body', fm));
    assert.equal(normalizePostDate(parsed.data.date, new Date('2026-10-08T12:00:00Z')), '2026-07-07');
  });

  test('missing title defaults to empty string, not undefined', () => {
    const fm = frontMatterFromPost({});
    assert.equal(fm.title, '');
  });
});

// ---------------------------------------------------------------------------
// normalizePostDate (front-matter `date` -> upsert-post payload)
// ---------------------------------------------------------------------------

describe('normalizePostDate', () => {
  const now = new Date('2026-10-08T12:00:00.000Z');

  test('absent values return null', () => {
    assert.equal(normalizePostDate(undefined, now), null);
    assert.equal(normalizePostDate(null, now), null);
    assert.equal(normalizePostDate('', now), null);
  });

  test('unquoted YAML date (Date at midnight UTC) becomes YYYY-MM-DD', () => {
    const fm = matter('---\ntitle: T\ndate: 2026-07-07\n---\nbody').data;
    assert.ok(fm.date instanceof Date);
    assert.equal(normalizePostDate(fm.date, now), '2026-07-07');
    assert.equal(normalizePostDate(new Date('2026-07-07T00:00:00.000Z'), now), '2026-07-07');
  });

  test('Date with a time becomes a full ISO timestamp', () => {
    assert.equal(normalizePostDate(new Date('2026-07-07T10:30:00Z'), now), '2026-07-07T10:30:00.000Z');
    const fm = matter('---\ntitle: T\ndate: 2026-07-07 10:30:00\n---\nbody').data;
    assert.equal(normalizePostDate(fm.date, now), '2026-07-07T10:30:00.000Z');
  });

  test('quoted date-only string is kept (trimmed)', () => {
    const fm = matter("---\ntitle: T\ndate: '2026-07-07'\n---\nbody").data;
    assert.equal(typeof fm.date, 'string');
    assert.equal(normalizePostDate(fm.date, now), '2026-07-07');
    assert.equal(normalizePostDate('  2026-07-07 ', now), '2026-07-07');
  });

  test('ISO timestamp strings are normalized to UTC', () => {
    assert.equal(normalizePostDate('2026-07-07T10:00:00Z', now), '2026-07-07T10:00:00.000Z');
    assert.equal(normalizePostDate('2026-07-07T10:00:00+02:00', now), '2026-07-07T08:00:00.000Z');
    assert.equal(normalizePostDate('2026-07-07T10:00+0200', now), '2026-07-07T08:00:00.000Z');
    assert.equal(normalizePostDate('2026-07-07 10:00:00', now), '2026-07-07T10:00:00.000Z', 'no offset = UTC');
  });

  test('invalid values throw an "invalid \"date\"" error', () => {
    for (const bad of ['2026-02-30', '07/07/2026', 'yesterday', '2026-07-07T25:00:00Z', '2026-02-30T10:00:00Z', 2026, true]) {
      assert.throws(() => normalizePostDate(bad, now), /invalid "date"/, `expected ${bad} to be rejected`);
    }
    assert.throws(() => normalizePostDate(new Date('nope'), now), /invalid "date"/);
  });

  test('future dates are rejected with a no-scheduling message', () => {
    assert.throws(() => normalizePostDate('2026-10-10', now), /future; scheduling posts is not supported/);
    assert.throws(() => normalizePostDate(new Date('2026-10-10T00:00:00Z'), now), /scheduling/);
    assert.throws(() => normalizePostDate('2026-10-08T12:06:00Z', now), /scheduling/);
  });

  test('a date-only value more than 14h ahead is rejected even if it is "tomorrow" in UTC', () => {
    const early = new Date('2026-10-08T09:00:00.000Z');
    assert.throws(() => normalizePostDate('2026-10-09', early), /scheduling/);
    assert.equal(normalizePostDate('2026-10-09', new Date('2026-10-08T10:00:00.000Z')), '2026-10-09');
  });

  test('today and tomorrow-in-UTC+14 are allowed for date-only; small clock skew allowed for timestamps', () => {
    assert.equal(normalizePostDate('2026-10-08', now), '2026-10-08');
    assert.equal(normalizePostDate('2026-10-09', now), '2026-10-09');
    assert.equal(normalizePostDate('2026-10-08T12:04:00Z', now), '2026-10-08T12:04:00.000Z');
  });
});

// ---------------------------------------------------------------------------
// findCompanionImage
// ---------------------------------------------------------------------------

describe('findCompanionImage', () => {
  function makeTmpDir() {
    const scratchpadRoot = '/tmp/claude-1000/-home-cosmin-projects-micropage-sh/9bf2df24-5f42-4f9d-8776-f0ca95f4c877/scratchpad';
    const base = fs.existsSync(scratchpadRoot) ? scratchpadRoot : os.tmpdir();
    return fs.mkdtempSync(path.join(base, 'posts-helpers-test-'));
  }

  test('finds <base>.<imgext> next to a .md file', () => {
    const dir = makeTmpDir();
    try {
      const mdPath = path.join(dir, '2026-01-01-launch.md');
      const pngPath = path.join(dir, '2026-01-01-launch.png');
      fs.writeFileSync(mdPath, '---\ntitle: Launch\n---\nbody');
      fs.writeFileSync(pngPath, Buffer.from([0x89, 0x50, 0x4e, 0x47]));

      const found = findCompanionImage(mdPath);
      assert.equal(found, pngPath);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test('returns null when no companion image is present', () => {
    const dir = makeTmpDir();
    try {
      const mdPath = path.join(dir, 'no-image.md');
      fs.writeFileSync(mdPath, '---\ntitle: No Image\n---\nbody');

      assert.equal(findCompanionImage(mdPath), null);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test('picks the first matching extension in IMAGE_EXTS order when multiple exist', () => {
    const dir = makeTmpDir();
    try {
      const mdPath = path.join(dir, 'multi.md');
      fs.writeFileSync(mdPath, '---\ntitle: Multi\n---\nbody');
      // IMAGE_EXTS order is .png, .jpg, .jpeg, .gif, .webp, .svg
      fs.writeFileSync(path.join(dir, 'multi.svg'), '<svg></svg>');
      fs.writeFileSync(path.join(dir, 'multi.png'), Buffer.from([0x89, 0x50, 0x4e, 0x47]));

      const found = findCompanionImage(mdPath);
      assert.equal(found, path.join(dir, 'multi.png'));
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

// ---------------------------------------------------------------------------
// MD_IMAGE_RE (body-image regex behavior) — resolveBodyImages itself calls
// into ./supabase for uploads/URLs, so it's not exercised end-to-end here.
// This asserts which refs the regex captures and which resolveBodyImages'
// own guard (isAbsoluteUrl / leading "/" / leading "#") would treat as
// "not local", mirroring the logic in posts-assets.js without invoking it.
// ---------------------------------------------------------------------------

describe('markdown image ref matching (mirrors resolveBodyImages local-ref filtering)', () => {
  const MD_IMAGE_RE = /!\[([^\]]*)\]\(\s*([^)\s]+)(?:\s+"[^"]*")?\s*\)/g;

  function extractRefs(body) {
    const refs = [];
    let match;
    MD_IMAGE_RE.lastIndex = 0;
    while ((match = MD_IMAGE_RE.exec(body)) !== null) {
      refs.push(match[2]);
    }
    return refs;
  }

  function isAbsoluteUrl(s) {
    return typeof s === 'string' && /^https?:\/\//i.test(s.trim());
  }

  function isConsideredLocal(ref) {
    return !(isAbsoluteUrl(ref) || ref.startsWith('/') || ref.startsWith('#'));
  }

  test('extracts refs from multiple image markdown patterns, including titles', () => {
    const body = [
      '![alt one](./local.png)',
      '![alt two](https://cdn.example.com/remote.png)',
      '![alt three](/root-absolute.png)',
      '![alt four](#anchor-ref.png)',
      '![alt five](assets/pic.jpg "a title")',
    ].join('\n\n');

    assert.deepEqual(extractRefs(body), [
      './local.png',
      'https://cdn.example.com/remote.png',
      '/root-absolute.png',
      '#anchor-ref.png',
      'assets/pic.jpg',
    ]);
  });

  test('classifies relative paths as local, and absolute URL / root-absolute / anchor refs as not-local', () => {
    assert.equal(isConsideredLocal('./local.png'), true);
    assert.equal(isConsideredLocal('assets/pic.jpg'), true);
    assert.equal(isConsideredLocal('https://cdn.example.com/remote.png'), false);
    assert.equal(isConsideredLocal('HTTP://cdn.example.com/caps.png'), false);
    assert.equal(isConsideredLocal('/root-absolute.png'), false);
    assert.equal(isConsideredLocal('#anchor-ref.png'), false);
  });

  test('non-greedy alt-text bracket matching stops at the first "]"', () => {
    const body = '![a] weird text](./oops.png)';
    // The regex requires "![...](" immediately after "]" - this body has a space
    // before "(" so it should NOT match as an image at all.
    assert.deepEqual(extractRefs(body), []);
  });
});

// ---------------------------------------------------------------------------
// rebuildTarget (which build `posts publish --watch` follows)
// ---------------------------------------------------------------------------

describe('rebuildTarget', () => {
  test('follows the server-reported rebuild_build_id over the active build', () => {
    assert.deepEqual(rebuildTarget([{ published_at: 'x', rebuild_build_id: 25 }], 30), { buildId: 25, serverReported: true });
  });

  test('a null rebuild_build_id means no rebuild, even with an active build', () => {
    assert.deepEqual(rebuildTarget([{ rebuild_build_id: null }], 30), { buildId: null, serverReported: true });
  });

  test('takes the last non-null id across several publishes', () => {
    assert.deepEqual(
      rebuildTarget([{ rebuild_build_id: null }, { rebuild_build_id: 25 }, { rebuild_build_id: 26 }], 30),
      { buildId: 26, serverReported: true },
    );
  });

  test('falls back to the active build when the server leaves the field out', () => {
    assert.deepEqual(rebuildTarget([{ published_at: 'x', emailed: false }], 30), { buildId: 30, serverReported: false });
    assert.deepEqual(rebuildTarget([{ published_at: 'x' }], null), { buildId: null, serverReported: false });
  });
});
