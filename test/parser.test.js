'use strict';
/**
 * Unit tests for the pure filesystem helpers in cli/src/parser.js.
 *
 * Scope: reads a temp dir; no Supabase / network.
 */

const { test, describe, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { readLlmsTxtFromDir } = require('../src/parser');

// ---------------------------------------------------------------------------
// readLlmsTxtFromDir
// ---------------------------------------------------------------------------

describe('readLlmsTxtFromDir', () => {
  let dir;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'micropage-llms-'));
  });

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  test('returns the content when llms.txt is present', () => {
    const content = '# My site\n\n- [Home](/): the landing page\n';
    fs.writeFileSync(path.join(dir, 'llms.txt'), content, 'utf8');
    // Only the trailing newline is dropped; interior content is preserved.
    assert.equal(readLlmsTxtFromDir(dir), '# My site\n\n- [Home](/): the landing page');
  });

  test('returns null when llms.txt is absent', () => {
    assert.equal(readLlmsTxtFromDir(dir), null);
  });

  test('returns null when llms.txt is whitespace-only', () => {
    fs.writeFileSync(path.join(dir, 'llms.txt'), '   \n\t\n  ', 'utf8');
    assert.equal(readLlmsTxtFromDir(dir), null);
  });
});
