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

const { slugify, defaultSlugFromFilename, frontMatterFromPost } = require('../src/commands/posts');
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

  test('missing title defaults to empty string, not undefined', () => {
    const fm = frontMatterFromPost({});
    assert.equal(fm.title, '');
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
