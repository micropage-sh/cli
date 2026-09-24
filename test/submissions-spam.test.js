'use strict';

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');

const { applySpamFilter } = require('../src/commands/submissions');

function recordingQuery() {
  const calls = [];
  const q = {
    calls,
    is(...args) { calls.push(['is', ...args]); return q; },
    not(...args) { calls.push(['not', ...args]); return q; },
  };
  return q;
}

describe('applySpamFilter', () => {
  test('default (inbox) keeps only unflagged rows', () => {
    const q = recordingQuery();
    const out = applySpamFilter(q, false);
    assert.equal(out, q);
    assert.deepEqual(q.calls, [['is', 'flagged_at', 'null']]);
  });

  test('--spam keeps only flagged rows', () => {
    const q = recordingQuery();
    const out = applySpamFilter(q, true);
    assert.equal(out, q);
    assert.deepEqual(q.calls, [['not', 'flagged_at', 'is', 'null']]);
  });

  test('undefined option behaves like default', () => {
    const q = recordingQuery();
    applySpamFilter(q, undefined);
    assert.deepEqual(q.calls, [['is', 'flagged_at', 'null']]);
  });
});
