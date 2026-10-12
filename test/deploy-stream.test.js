'use strict';
/**
 * streamDeployEventsUntilDone against stubbed deploy-events-stream responses:
 * `build.superseded` hand-offs (followed by the server, or by the client
 * reconnecting), the null hand-off, the hop cap, and the generic fallback line.
 */

const { test, describe, beforeEach, afterEach, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'micropage-cli-test-'));
process.env.HOME = tmpHome;
process.env.USERPROFILE = tmpHome;

const {
  streamDeployEventsUntilDone,
  formatDeployEventForConsole,
  supersededTarget,
  MAX_SUPERSEDE_HOPS,
} = require('../src/supabase');

after(() => {
  fs.rmSync(tmpHome, { recursive: true, force: true });
});

function sseResponse(events) {
  const enc = new TextEncoder();
  const body = new ReadableStream({
    start(controller) {
      for (const ev of events) controller.enqueue(enc.encode(`data: ${JSON.stringify(ev)}\n\n`));
      controller.close();
    },
  });
  return new Response(body, { status: 200, headers: { 'Content-Type': 'text/event-stream' } });
}

function superseded(id, buildId, to, reason = 'publish', { withBuildId = true } = {}) {
  const ev = {
    id,
    event_type: 'build.superseded',
    payload: { superseded_by_build_id: to, reason },
    created_at: 't',
  };
  if (withBuildId) ev.build_id = buildId;
  return ev;
}

let realFetch;
let realLog;
let realError;
let calls;
let logs;

/** Responses are served in order; each call records its query params. */
function stubFetch(responses) {
  const queue = [...responses];
  globalThis.fetch = async (url) => {
    const u = new URL(url);
    calls.push(Object.fromEntries(u.searchParams.entries()));
    const next = queue.shift();
    if (!next) throw new Error(`unexpected fetch ${url}`);
    return typeof next === 'function' ? next() : next;
  };
}

beforeEach(() => {
  realFetch = globalThis.fetch;
  realLog = console.log;
  realError = console.error;
  calls = [];
  logs = [];
  console.log = (...args) => logs.push(args.join(' '));
  console.error = (...args) => logs.push(args.join(' '));
});

afterEach(() => {
  globalThis.fetch = realFetch;
  console.log = realLog;
  console.error = realError;
});

describe('streamDeployEventsUntilDone', () => {
  test('ends on a terminal event and keeps the original build id', async () => {
    stubFetch([
      sseResponse([
        { id: 5, event_type: 'build.started', created_at: 't' },
        { id: 6, event_type: 'deployment.completed', created_at: 't' },
      ]),
    ]);
    const res = await streamDeployEventsUntilDone('tok', 1, 10, { afterId: 4 });
    assert.equal(res.terminalEvent.event_type, 'deployment.completed');
    assert.equal(res.buildId, 10);
    assert.deepEqual(res.superseded, []);
    assert.equal(calls.length, 1);
    assert.equal(calls[0].afterId, '4');
  });

  test('server-side follow: ends on the hand-off build completion over one connection', async () => {
    stubFetch([
      sseResponse([
        { id: 5, build_id: 10, event_type: 'build.enqueued', created_at: 't' },
        superseded(6, 10, 11),
        { id: 7, build_id: 11, event_type: 'build.started', created_at: 't' },
        { id: 8, build_id: 11, event_type: 'deployment.completed', created_at: 't' },
      ]),
    ]);
    const res = await streamDeployEventsUntilDone('tok', 1, 10);
    assert.equal(calls.length, 1);
    assert.equal(res.terminalEvent.id, 8);
    assert.equal(res.buildId, 11);
    assert.deepEqual(res.superseded, [{ build_id: 10, superseded_by_build_id: 11, reason: 'publish' }]);
    assert.ok(
      logs.some((l) => l.includes('build 10 superseded by build 11 (publish); following it')),
      logs.join('\n'),
    );
  });

  test('older edge function (no build_id on events): reconnects to Y from the superseded id', async () => {
    stubFetch([
      sseResponse([superseded(6, 10, 11, 'live_build_changed', { withBuildId: false })]),
      sseResponse([{ id: 9, event_type: 'deployment.completed', created_at: 't' }]),
    ]);
    const res = await streamDeployEventsUntilDone('tok', 1, '10', { afterId: 3 });
    assert.equal(calls.length, 2);
    assert.deepEqual(
      calls.map((c) => [c.projectId, c.buildId, c.afterId]),
      [['1', '10', '3'], ['1', '11', '6']],
    );
    assert.equal(res.terminalEvent.id, 9);
    assert.equal(res.buildId, 11);
  });

  test('reconnects when the connection closes right after a hand-off', async () => {
    stubFetch([
      sseResponse([superseded(6, 10, 11)]),
      sseResponse([{ id: 9, build_id: 11, event_type: 'build.failed', payload: { error: 'x' }, created_at: 't' }]),
    ]);
    const res = await streamDeployEventsUntilDone('tok', 1, 10);
    assert.equal(calls.length, 2);
    assert.equal(calls[1].buildId, '11');
    assert.equal(calls[1].afterId, '6');
    assert.equal(res.terminalEvent.event_type, 'build.failed');
    assert.equal(res.buildId, 11);
  });

  test('does not reconnect when other events followed the hand-off before the close', async () => {
    stubFetch([
      sseResponse([superseded(6, 10, 11), { id: 7, build_id: 11, event_type: 'build.started', created_at: 't' }]),
    ]);
    const res = await streamDeployEventsUntilDone('tok', 1, 10);
    assert.equal(calls.length, 1);
    assert.equal(res.terminalEvent, null);
    assert.equal(res.buildId, 11);
  });

  test('null hand-off is terminal', async () => {
    stubFetch([sseResponse([superseded(6, 10, null, 'live_build_changed')])]);
    const res = await streamDeployEventsUntilDone('tok', 1, 10);
    assert.equal(calls.length, 1);
    assert.equal(res.terminalEvent.event_type, 'build.superseded');
    assert.equal(res.buildId, 10);
    assert.deepEqual(res.superseded, []);
    assert.ok(logs.some((l) => l.includes('build 10 superseded; nothing further to deploy')), logs.join('\n'));
  });

  test('a hand-off to the watched build itself is terminal', async () => {
    stubFetch([sseResponse([superseded(6, 10, 10, 'publish', { withBuildId: false })])]);
    const res = await streamDeployEventsUntilDone('tok', 1, 10);
    assert.equal(calls.length, 1);
    assert.equal(res.terminalEvent.id, 6);
    assert.equal(res.buildId, 10);
    assert.ok(logs.some((l) => l.includes('not following it')), logs.join('\n'));
  });

  for (const bad of ['abc', 1.5, -3, 0, { id: 11 }, '11; drop', true]) {
    test(`a non-integer hand-off (${JSON.stringify(bad)}) is terminal`, async () => {
      stubFetch([sseResponse([superseded(6, 10, bad, 'publish', { withBuildId: false })])]);
      const res = await streamDeployEventsUntilDone('tok', 1, 10);
      assert.equal(calls.length, 1);
      assert.equal(res.terminalEvent.id, 6);
      assert.equal(res.buildId, 10);
    });
  }

  test('stops following after the hop cap', async () => {
    const responses = [];
    for (let i = 0; i <= MAX_SUPERSEDE_HOPS; i += 1) {
      responses.push(sseResponse([superseded(100 + i, 10 + i, 11 + i, 'publish', { withBuildId: false })]));
    }
    stubFetch(responses);
    const res = await streamDeployEventsUntilDone('tok', 1, 10);
    assert.equal(calls.length, MAX_SUPERSEDE_HOPS + 1);
    assert.equal(res.superseded.length, MAX_SUPERSEDE_HOPS);
    assert.equal(res.buildId, 10 + MAX_SUPERSEDE_HOPS);
    assert.equal(res.terminalEvent.id, 100 + MAX_SUPERSEDE_HOPS);
    assert.ok(logs[logs.length - 1].includes('not following it'), logs.join('\n'));
  });

  test('stops at the hop cap on a server-followed connection too', async () => {
    const events = [];
    for (let i = 0; i <= MAX_SUPERSEDE_HOPS + 2; i += 1) events.push(superseded(100 + i, 10 + i, 11 + i));
    stubFetch([sseResponse(events)]);
    const res = await streamDeployEventsUntilDone('tok', 1, 10);
    assert.equal(calls.length, 1);
    assert.equal(res.superseded.length, MAX_SUPERSEDE_HOPS);
    assert.equal(res.terminalEvent.id, 100 + MAX_SUPERSEDE_HOPS);
  });

  test('a hand-off the server rejects as not in the project ends the watch on the last build', async () => {
    stubFetch([
      sseResponse([superseded(6, 10, 999, 'publish', { withBuildId: false })]),
      new Response(JSON.stringify({ error: 'Build not found for project' }), { status: 404 }),
    ]);
    const res = await streamDeployEventsUntilDone('tok', 1, 10);
    assert.equal(calls.length, 2);
    assert.equal(calls[1].buildId, '999');
    assert.equal(res.buildId, 10);
    assert.equal(res.terminalEvent.id, 6);
    assert.ok(logs.some((l) => l.includes('build 999 not found for this project')), logs.join('\n'));
  });

  test('a 404 on the first connection still throws', async () => {
    stubFetch([new Response('nope', { status: 404 })]);
    await assert.rejects(() => streamDeployEventsUntilDone('tok', 1, 10), /nope/);
  });

  test('unknown event types print generically and do not end the stream', async () => {
    stubFetch([
      sseResponse([
        { id: 5, event_type: 'build.mystery', payload: { a: 1 }, created_at: 't' },
        { id: 6, event_type: 'deployment.completed', created_at: 't' },
      ]),
    ]);
    const res = await streamDeployEventsUntilDone('tok', 1, 10);
    assert.equal(res.terminalEvent.id, 6);
    assert.ok(logs.includes('[t] build.mystery {"a":1}'), logs.join('\n'));
  });

  test('followSuperseded: false sends follow=0 and waits past a superseded hand-off', async () => {
    stubFetch([
      sseResponse([
        { id: 5, build_id: 10, event_type: 'archive.started', created_at: 't' },
        superseded(6, 10, 11),
        superseded(7, 10, null, 'live_build_changed'),
        { id: 8, build_id: 10, event_type: 'archive.completed', payload: { archive_url: 'u' }, created_at: 't' },
      ]),
    ]);
    const res = await streamDeployEventsUntilDone('tok', 1, 10, { afterId: 4, followSuperseded: false });
    assert.equal(calls.length, 1);
    assert.equal(calls[0].follow, '0');
    assert.equal(calls[0].buildId, '10');
    assert.equal(res.terminalEvent.event_type, 'archive.completed');
    assert.equal(res.buildId, 10);
    assert.deepEqual(res.superseded, []);
    assert.ok(
      logs.some((l) => l.includes('build 10 superseded by build 11 (publish); not following it')),
      logs.join('\n'),
    );
  });

  test('followSuperseded: false does not reconnect when the stream closes after a hand-off', async () => {
    stubFetch([sseResponse([superseded(6, 10, 11, 'publish', { withBuildId: false })])]);
    const res = await streamDeployEventsUntilDone('tok', 1, 10, { followSuperseded: false });
    assert.equal(calls.length, 1);
    assert.equal(res.terminalEvent, null);
    assert.equal(res.buildId, 10);
    assert.deepEqual(res.superseded, []);
  });

  test('default (follow) does not send the follow param', async () => {
    stubFetch([sseResponse([{ id: 6, event_type: 'deployment.completed', created_at: 't' }])]);
    await streamDeployEventsUntilDone('tok', 1, 10);
    assert.equal(calls[0].follow, undefined);
  });

  test('a stream error event throws', async () => {
    stubFetch([sseResponse([{ error: 'stream timeout' }])]);
    await assert.rejects(() => streamDeployEventsUntilDone('tok', 1, 10), /stream timeout/);
  });
});

describe('supersededTarget / formatDeployEventForConsole', () => {
  test('accepts positive integers and digit strings only', () => {
    assert.equal(supersededTarget({ payload: { superseded_by_build_id: 42 } }), 42);
    assert.equal(supersededTarget({ payload: { superseded_by_build_id: '42' } }), 42);
    assert.equal(supersededTarget({ payload: { superseded_by_build_id: null } }), null);
    assert.equal(supersededTarget({ payload: { superseded_by_build_id: 4.2 } }), null);
    assert.equal(supersededTarget({ payload: {} }), null);
    assert.equal(supersededTarget({}), null);
  });

  test('uses the watched build when the event has no build_id', () => {
    const line = formatDeployEventForConsole(
      { event_type: 'build.superseded', payload: { superseded_by_build_id: 8, reason: 'publish' } },
      { buildId: 7 },
    );
    assert.equal(line, 'build.superseded: build 7 superseded by build 8 (publish); following it');
  });
});
