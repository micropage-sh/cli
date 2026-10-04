'use strict';
/**
 * Server tier refusals return `{ error, code: "plan_required", required_tier,
 * upgrade_url }` with their usual 402/403 status. These tests cover how the
 * CLI tags those errors (PLAN_REQUIRED) and formats the upgrade message, using
 * fetch stubs only.
 */

const { test, describe, before, after, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

// auth.js resolves the config dir from HOME at load time, so point it at a
// throwaway dir holding a non-expired session before requiring anything.
const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'micropage-cli-test-'));
process.env.HOME = tmpHome;
process.env.USERPROFILE = tmpHome;

function fakeJwt(expSecondsFromNow) {
  const b64 = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
  return `${b64({ alg: 'none' })}.${b64({ exp: Math.floor(Date.now() / 1000) + expSecondsFromNow })}.sig`;
}

fs.mkdirSync(path.join(tmpHome, '.micropage'), { recursive: true });
fs.writeFileSync(
  path.join(tmpHome, '.micropage', 'config.json'),
  JSON.stringify({ access_token: fakeJwt(3600), refresh_token: 'r' }),
);

const supabase = require('../src/supabase');
const { formatPlanRequiredMessage } = require('../src/plan');

const realFetch = global.fetch;

function stubFetch(status, body) {
  const calls = [];
  global.fetch = async (url, options) => {
    calls.push({ url, options });
    const text = typeof body === 'string' ? body : JSON.stringify(body);
    return new Response(text, { status, headers: { 'Content-Type': 'application/json' } });
  };
  return calls;
}

const planBody = {
  error: 'Deploy tokens require the Pro+ plan.',
  code: 'plan_required',
  required_tier: 'pro_plus',
  upgrade_url: 'https://micropage.sh/pricing?from=cli',
};

afterEach(() => {
  global.fetch = realFetch;
});

after(() => {
  fs.rmSync(tmpHome, { recursive: true, force: true });
});

describe('attachPlanRequired', () => {
  test('tags plan_required bodies', () => {
    const err = supabase.attachPlanRequired(new Error('x'), planBody);
    assert.equal(err.code, 'PLAN_REQUIRED');
    assert.equal(err.requiredTier, 'pro_plus');
    assert.equal(err.upgradeUrl, 'https://micropage.sh/pricing?from=cli');
  });

  test('leaves other bodies alone', () => {
    for (const data of [null, 'text', { error: 'Forbidden' }, { code: 'other' }]) {
      const err = supabase.attachPlanRequired(new Error('x'), data);
      assert.equal(err.code, undefined);
      assert.equal(err.requiredTier, undefined);
    }
  });

  test('missing tier / url become null', () => {
    const err = supabase.attachPlanRequired(new Error('x'), { code: 'plan_required' });
    assert.equal(err.code, 'PLAN_REQUIRED');
    assert.equal(err.requiredTier, null);
    assert.equal(err.upgradeUrl, null);
  });
});

describe('exchangeDeployTokenForAccessToken', () => {
  test('403 plan_required -> PLAN_REQUIRED with server message', async () => {
    stubFetch(403, planBody);
    await assert.rejects(
      supabase.exchangeDeployTokenForAccessToken('tok', 'uuid-1'),
      (err) => {
        assert.equal(err.status, 403);
        assert.equal(err.code, 'PLAN_REQUIRED');
        assert.equal(err.requiredTier, 'pro_plus');
        assert.equal(err.message, planBody.error);
        assert.deepEqual(err.data, planBody);
        return true;
      },
    );
  });

  test('plain 403 (invalid token) is not tagged', async () => {
    stubFetch(403, { error: 'Invalid deploy token' });
    await assert.rejects(
      supabase.exchangeDeployTokenForAccessToken('tok', 'uuid-1'),
      (err) => {
        assert.equal(err.status, 403);
        assert.equal(err.code, undefined);
        assert.equal(err.message, 'Invalid deploy token');
        return true;
      },
    );
  });
});

describe('invokePublishBuild', () => {
  test('402 plan_required -> PLAN_REQUIRED', async () => {
    stubFetch(402, { ...planBody, required_tier: 'pro' });
    await assert.rejects(supabase.invokePublishBuild('jwt', 1, 2), (err) => {
      assert.equal(err.status, 402);
      assert.equal(err.code, 'PLAN_REQUIRED');
      assert.equal(err.requiredTier, 'pro');
      return true;
    });
  });
});

describe('session request helper (fn.invoke)', () => {
  test('403 plan_required -> PLAN_REQUIRED', async () => {
    const calls = stubFetch(403, { ...planBody, error: 'Custom domains require Pro.', required_tier: 'pro' });
    await assert.rejects(supabase.fn.invoke('save-custom-domain', { x: 1 }), (err) => {
      assert.equal(err.status, 403);
      assert.equal(err.code, 'PLAN_REQUIRED');
      assert.equal(err.requiredTier, 'pro');
      assert.equal(err.message, 'Custom domains require Pro.');
      return true;
    });
    assert.equal(calls.length, 1);
    assert.match(calls[0].url, /\/functions\/v1\/save-custom-domain$/);
  });

  test('plain 403 keeps status and no code', async () => {
    stubFetch(403, { error: 'Not your project' });
    await assert.rejects(supabase.fn.invoke('request-build-archive', {}), (err) => {
      assert.equal(err.status, 403);
      assert.equal(err.code, undefined);
      return true;
    });
  });
});

describe('handleAuthError', () => {
  let exitCode;
  let printed;
  const realExit = process.exit;
  const realError = console.error;

  before(() => {
    process.exit = (code) => {
      exitCode = code;
      throw new Error('__exit__');
    };
    console.error = (...args) => {
      printed.push(args.join(' '));
    };
  });

  after(() => {
    process.exit = realExit;
    console.error = realError;
  });

  test('prints upgrade message and exits 1 for PLAN_REQUIRED', () => {
    exitCode = undefined;
    printed = [];
    const err = supabase.attachPlanRequired(new Error(planBody.error), planBody);
    assert.throws(() => supabase.handleAuthError(err), /__exit__/);
    assert.equal(exitCode, 1);
    const out = printed.join('\n');
    assert.match(out, /Deploy tokens require the Pro\+ plan\./);
    assert.match(out, /This requires the Pro\+ plan\./);
    assert.match(out, /Upgrade at: https:\/\/micropage\.sh\/pricing\?from=cli/);
  });

  test('ignores unrelated errors', () => {
    exitCode = undefined;
    printed = [];
    supabase.handleAuthError(Object.assign(new Error('boom'), { status: 500 }));
    assert.equal(exitCode, undefined);
    assert.equal(printed.length, 0);
  });
});

describe('formatPlanRequiredMessage', () => {
  test('pro tier label', () => {
    const msg = formatPlanRequiredMessage({ message: 'Nope.', requiredTier: 'pro', upgradeUrl: null });
    assert.equal(msg, 'Nope.\n\nThis requires the Pro plan.\n\nUpgrade at: https://micropage.sh/pricing');
  });

  test('unknown tier falls back to a generic paid plan', () => {
    const msg = formatPlanRequiredMessage({ message: '', requiredTier: null });
    assert.equal(msg, 'This requires a paid plan.\n\nUpgrade at: https://micropage.sh/pricing');
  });
});
