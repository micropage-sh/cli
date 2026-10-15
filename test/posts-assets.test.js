'use strict';

const { test, describe, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const supabase = require('../src/supabase');
const { resolveHeroImage, resolveBodyImages } = require('../src/posts-assets');

// Other tests stub supabase calls, which hides a call to a function the module
// never exported. Check every `supabase.<name>` the source uses against the real exports.
describe('supabase module exports', () => {
  const srcDir = path.join(__dirname, '..', 'src');
  const files = fs.readdirSync(srcDir, { recursive: true })
    .filter((f) => f.endsWith('.js'))
    .map((f) => path.join(srcDir, f));

  for (const file of files) {
    const src = fs.readFileSync(file, 'utf8');
    if (!/require\(['"](\.\.?\/)+supabase['"]\)/.test(src)) continue;
    const used = new Set([...src.matchAll(/\bsupabase\.(\w+)/g)].map((m) => m[1]));
    for (const name of used) {
      test(`${path.relative(srcDir, file)} uses exported supabase.${name}`, () => {
        assert.notEqual(supabase[name], undefined, `supabase.${name} is not exported`);
      });
    }
  }
});

describe('posts push uploads local images', () => {
  const originals = {};
  function stub(name, fn) {
    originals[name] = supabase[name];
    supabase[name] = fn;
  }
  afterEach(() => {
    for (const [name, fn] of Object.entries(originals)) supabase[name] = fn;
  });

  function setup() {
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'mp-assets-'));
    fs.mkdirSync(path.join(cwd, 'posts'));
    fs.mkdirSync(path.join(cwd, 'assets'));
    fs.writeFileSync(path.join(cwd, 'assets', 'hero.png'), 'png-bytes');
    fs.writeFileSync(path.join(cwd, 'posts', 'diagram.png'), 'diagram-bytes');
    const postFilePath = path.join(cwd, 'posts', 'hello.md');
    fs.writeFileSync(postFilePath, '---\ntitle: Hello\n---\n');
    const uploads = [];
    stub('uploadAssetWithToken', async (_token, _projectId, _filePath, filename) => {
      uploads.push(filename);
      return { file: { id: `id-${filename}`, filename, content_hash: `h-${filename}` } };
    });
    stub('fn', {
      invokeGet: async (name, params) => {
        assert.equal(name, 'get-file-url');
        return { url: `https://files.micropage.sh/projects/1/${params.file_id}` };
      },
    });
    const fileIndex = { byFilename: new Map(), byHash: new Map(), urlById: new Map() };
    return { cwd, postFilePath, uploads, fileIndex };
  }

  test('uploads a hero from assets/ and returns its hosted URL', async () => {
    const { cwd, postFilePath, uploads, fileIndex } = setup();
    const r = await resolveHeroImage({
      accessToken: 't', projectId: 1, postFilePath, cwd, heroFrontMatter: 'hero.png', fileIndex,
    });
    assert.deepEqual(uploads, ['hero.png']);
    assert.equal(r.url, 'https://files.micropage.sh/projects/1/id-hero.png');
  });

  test('uploads a companion image next to the post', async () => {
    const { cwd, postFilePath, uploads, fileIndex } = setup();
    fs.writeFileSync(path.join(cwd, 'posts', 'hello.png'), 'companion-bytes');
    const r = await resolveHeroImage({ accessToken: 't', projectId: 1, postFilePath, cwd, fileIndex });
    assert.deepEqual(uploads, ['hello.png']);
    assert.equal(r.source, 'companion:hello.png');
  });

  test('uploads body images and rewrites them to hosted URLs', async () => {
    const { cwd, postFilePath, uploads, fileIndex } = setup();
    const r = await resolveBodyImages({
      accessToken: 't', projectId: 1, postFilePath, cwd, body: 'See ![d](diagram.png).', fileIndex,
    });
    assert.deepEqual(uploads, ['diagram.png']);
    assert.equal(r.markdown, 'See ![d](https://files.micropage.sh/projects/1/id-diagram.png).');
  });
});
