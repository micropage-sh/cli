'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

const CONFIG_PATH = path.join(__dirname, '..', 'src', 'config.js');

function loadConfig(env) {
  const saved = process.env.MICROPAGE_BASE_DOMAIN;
  if (env.MICROPAGE_BASE_DOMAIN === undefined) delete process.env.MICROPAGE_BASE_DOMAIN;
  else process.env.MICROPAGE_BASE_DOMAIN = env.MICROPAGE_BASE_DOMAIN;
  delete require.cache[CONFIG_PATH];
  try {
    return require(CONFIG_PATH);
  } finally {
    if (saved === undefined) delete process.env.MICROPAGE_BASE_DOMAIN;
    else process.env.MICROPAGE_BASE_DOMAIN = saved;
    delete require.cache[CONFIG_PATH];
  }
}

test('platform sites default to micropage.live', () => {
  const { BASE_DOMAIN, projectUrl } = loadConfig({});
  assert.equal(BASE_DOMAIN, 'micropage.live');
  assert.equal(projectUrl('acme', null), 'https://acme.micropage.live');
});

test('MICROPAGE_BASE_DOMAIN overrides the platform domain', () => {
  const { BASE_DOMAIN, projectUrl } = loadConfig({ MICROPAGE_BASE_DOMAIN: 'micropage.sh' });
  assert.equal(BASE_DOMAIN, 'micropage.sh');
  assert.equal(projectUrl('acme', null), 'https://acme.micropage.sh');
});

test('projectUrl prefers the custom domain and tolerates schemes and blanks', () => {
  const { projectUrl } = loadConfig({});
  assert.equal(projectUrl('acme', 'www.example.com'), 'https://www.example.com');
  assert.equal(projectUrl('acme', 'https://www.example.com'), 'https://www.example.com');
  assert.equal(projectUrl('acme', '  '), 'https://acme.micropage.live');
  assert.equal(projectUrl('https://already.example', null), 'https://already.example');
  assert.equal(projectUrl('', null), null);
  assert.equal(projectUrl(null, null), null);
});
