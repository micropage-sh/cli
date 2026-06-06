'use strict';

/**
 * Thin Supabase client for the CLI.
 *
 * Uses the stored user session (access_token + refresh_token) together with
 * the public anon key for every request. RLS on the database enforces ownership.
 *
 * Supports:
 *  - db.from(table)  – PostgREST query builder
 *  - fn.invoke(name, body?)  – edge function calls
 */

const { getSession, setSession, clearSession } = require('./auth');
const { SUPABASE_URL, SUPABASE_ANON_KEY } = require('./config');

// ---------------------------------------------------------------------------
// JWT helpers
// ---------------------------------------------------------------------------

function isTokenExpired(token) {
  try {
    const b64 = token.split('.')[1];
    const payload = JSON.parse(Buffer.from(b64, 'base64').toString());
    // Refresh if expiry is within 60 seconds
    return payload.exp < Math.floor(Date.now() / 1000) + 60;
  } catch {
    return true;
  }
}

/** Single in-flight refresh so parallel requests cannot reuse the same refresh_token (rotation revokes it). */
let refreshInFlight = null;

async function refreshSession() {
  if (refreshInFlight) {
    return refreshInFlight;
  }

  const session = getSession();
  if (!session?.refresh_token) return null;

  refreshInFlight = (async () => {
    const res = await fetch(`${SUPABASE_URL}/auth/v1/token?grant_type=refresh_token`, {
      method: 'POST',
      headers: {
        'apikey': SUPABASE_ANON_KEY,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ refresh_token: session.refresh_token }),
    });

    if (!res.ok) {
      const body = await res.text().catch(() => '');
      console.error(`[micropage] token refresh failed (HTTP ${res.status}): ${body}`);
      return null;
    }
    const data = await res.json();
    if (!data.access_token) return null;

    const newSession = {
      access_token: data.access_token,
      refresh_token: data.refresh_token || session.refresh_token,
      user: data.user || session.user,
    };
    setSession(newSession);
    return newSession;
  })().finally(() => {
    refreshInFlight = null;
  });

  return refreshInFlight;
}

function makeAuthError(code, message) {
  const err = new Error(message);
  err.code = code;
  return err;
}

async function getValidAccessToken() {
  let session = getSession();
  if (!session) {
    throw makeAuthError('NO_SESSION', 'Not logged in. Run: micropage login');
  }
  if (isTokenExpired(session.access_token)) {
    session = await refreshSession();
    if (!session) {
      clearSession();
      throw makeAuthError('SESSION_EXPIRED', 'Session expired. Run: micropage login');
    }
  }
  return session.access_token;
}

// ---------------------------------------------------------------------------
// Base request
// ---------------------------------------------------------------------------

async function requestWithToken(method, url, body, accessToken, extraHeaders = {}) {
  const headers = {
    'apikey': SUPABASE_ANON_KEY,
    'Authorization': `Bearer ${accessToken}`,
    'Content-Type': 'application/json',
    ...extraHeaders,
  };

  const options = { method, headers };
  if (body !== null && body !== undefined) {
    options.body = JSON.stringify(body);
  }

  const res = await fetch(url, options);
  const text = await res.text();
  let data = null;
  try { data = text ? JSON.parse(text) : null; } catch { data = text || null; }

  if (!res.ok) {
    const msg =
      (typeof data === 'object' && data && (data.message || data.error)) ||
      res.statusText ||
      `HTTP ${res.status}`;
    const err = new Error(msg);
    err.status = res.status;
    err.data = data;
    throw err;
  }

  return data;
}

async function request(method, url, body, extraHeaders = {}) {
  const token = await getValidAccessToken();
  const headers = {
    'apikey': SUPABASE_ANON_KEY,
    'Authorization': `Bearer ${token}`,
    'Content-Type': 'application/json',
    ...extraHeaders,
  };

  const options = { method, headers };
  if (body !== null && body !== undefined) {
    options.body = JSON.stringify(body);
  }

  let res = await fetch(url, options);

  // On 401, attempt one silent refresh and retry before giving up.
  // This covers clock-skew and edge cases where the token expired server-side
  // slightly before isTokenExpired() would have caught it proactively.
  if (res.status === 401) {
    const refreshed = await refreshSession();
    if (refreshed) {
      options.headers = {
        ...options.headers,
        'Authorization': `Bearer ${refreshed.access_token}`,
      };
      res = await fetch(url, options);
    }
  }

  const text = await res.text();
  let data = null;
  try { data = text ? JSON.parse(text) : null; } catch { data = text || null; }

  if (!res.ok) {
    const msg =
      (typeof data === 'object' && data && (data.message || data.error)) ||
      res.statusText ||
      `HTTP ${res.status}`;
    const err = new Error(msg);
    err.status = res.status;
    err.data = data;
    if (res.status === 401) err.code = 'SESSION_EXPIRED';
    throw err;
  }

  return data;
}

// ---------------------------------------------------------------------------
// Edge function invocations
// ---------------------------------------------------------------------------

const fn = {
  async invoke(name, body = null) {
    return request('POST', `${SUPABASE_URL}/functions/v1/${name}`, body);
  },
  async invokeGet(name, params = {}) {
    const qs = new URLSearchParams(params).toString();
    const url = `${SUPABASE_URL}/functions/v1/${name}${qs ? '?' + qs : ''}`;
    return request('GET', url, null);
  },
};

// ---------------------------------------------------------------------------
// PostgREST query builder
// ---------------------------------------------------------------------------

function buildQuery(table) {
  const filters = [];
  let _select = '*';
  let _order = null;
  let _limit = null;

  const q = {
    select(cols) { _select = cols; return q; },
    eq(col, val) { filters.push(`${col}=eq.${val}`); return q; },
    in(col, vals) { filters.push(`${col}=in.(${vals.join(',')})`); return q; },
    order(col, dir = 'asc') { _order = `${col}.${dir}`; return q; },
    limit(n) { _limit = n; return q; },

    async execute(method = 'GET', body = null, extraHeaders = {}) {
      const params = new URLSearchParams();
      params.set('select', _select);
      for (const f of filters) {
        const [key, value] = f.split('=');
        params.append(key, value);
      }
      if (_order) params.set('order', _order);
      if (_limit) params.set('limit', String(_limit));

      const url = `${SUPABASE_URL}/rest/v1/${table}?${params.toString()}`;
      return request(method, url, body, extraHeaders);
    },

    async get() { return q.execute('GET'); },

    async single() {
      const results = await q.limit(1).execute('GET');
      return Array.isArray(results) ? results[0] || null : results;
    },

    async insert(data) {
      const url = `${SUPABASE_URL}/rest/v1/${table}`;
      return request('POST', url, data, { 'Prefer': 'return=representation' });
    },

    async update(data) {
      return q.execute('PATCH', data, { 'Prefer': 'return=representation' });
    },

    async delete() {
      return q.execute('DELETE', null, { 'Prefer': 'return=representation' });
    },
  };

  return q;
}

const db = {
  from: (table) => buildQuery(table),
};

// ---------------------------------------------------------------------------
// Auth helpers (user info)
// ---------------------------------------------------------------------------

async function getUserInfo(accessToken) {
  let res;
  try {
    res = await fetch(`${SUPABASE_URL}/auth/v1/user`, {
      headers: {
        'apikey': SUPABASE_ANON_KEY,
        'Authorization': `Bearer ${accessToken}`,
      },
    });
  } catch (err) {
    console.error(`[micropage] getUserInfo network error: ${err.message}`);
    return null;
  }
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    console.error(`[micropage] getUserInfo failed (HTTP ${res.status} from ${SUPABASE_URL}/auth/v1/user): ${body}`);
    return null;
  }
  return res.json();
}

// ---------------------------------------------------------------------------
// Common error handler for commands
// ---------------------------------------------------------------------------

function handleAuthError(err) {
  if (err.code === 'NO_SESSION' || err.code === 'SESSION_EXPIRED') {
    console.error(err.message);
    process.exit(1);
  }
}

// ---------------------------------------------------------------------------
// Deploy token + SSE (Edge functions with verify_jwt = false + Bearer token)
// ---------------------------------------------------------------------------

const TERMINAL_DEPLOY_EVENTS = new Set([
  'build.failed',
  'deployment.completed',
  'archive.completed',
  'archive.failed',
]);

/**
 * Human-readable line for deploy stream (falls back to event_type + JSON payload).
 * @param {{ event_type?: string, payload?: Record<string, unknown> }} ev
 */
function formatDeployEventForConsole(ev) {
  const eventType = ev.event_type || '';
  const payload = ev.payload && typeof ev.payload === 'object' ? ev.payload : null;
  if (eventType === 'deployment.domain_wiring' && payload) {
    const step = payload.step;
    const host = typeof payload.hostname === 'string' ? payload.hostname : '';
    const https = host ? `https://${host}` : '';
    switch (step) {
      case 'started':
        return `${eventType}: preparing ${host || 'platform hostname'}`;
      case 'dns_ok':
        return `${eventType}: DNS CNAME ready (${host})`;
      case 'dns_resolve_ok':
        return payload.skipped
          ? `${eventType}: skipped public DNS wait`
          : `${eventType}: hostname resolves (${host})`;
      case 'attach_ok':
        return `${eventType}: registered on Cloudflare Pages (${host})`;
      case 'polling':
        return `${eventType}: Pages status "${payload.pages_status || '…'}" (${host})`;
      case 'active':
        return `${eventType}: live — ${https}`;
      case 'failed':
        return `${eventType}: failed — ${payload.error || 'unknown'}`;
      case 'timeout':
        return `${eventType}: still pending after wait (try ${https || 'URL'} shortly)`;
      default:
        break;
    }
  }
  const extra = ev.payload ? ` ${JSON.stringify(ev.payload)}` : '';
  return `${eventType}${extra}`;
}

/**
 * Highest `build_deploy_events.id` for this build (for SSE `afterId` cursor).
 * Pass accessToken when using exchanged deploy JWT (CI); omit for normal session.
 */
async function getMaxDeployEventIdForBuild(buildId, accessToken = null) {
  const url = `${SUPABASE_URL}/rest/v1/build_deploy_events?select=id&build_id=eq.${encodeURIComponent(String(buildId))}&order=id.desc&limit=1`;
  const data =
    accessToken != null && String(accessToken).trim() !== ''
      ? await requestWithToken('GET', url, null, accessToken)
      : await request('GET', url, null);
  const row = Array.isArray(data) ? data[0] : null;
  if (!row || row.id == null) return 0;
  const n = Number(row.id);
  return Number.isFinite(n) ? n : 0;
}

/**
 * Stream build/deploy/archive events until a terminal event or the connection closes.
 * @param {string} bearerToken
 * @param {number|string} projectId
 * @param {number|string} buildId
 * @param {{ afterId?: number }} [options] afterId skips older rows (avoids instant exit on past deployment.completed)
 * @returns {Promise<{ terminalEvent: object | null }>}
 */
async function streamDeployEventsUntilDone(bearerToken, projectId, buildId, options = {}) {
  const qs = new URLSearchParams({
    projectId: String(projectId),
    buildId: String(buildId),
  });
  const aid = options.afterId;
  if (aid != null && Number(aid) > 0) {
    qs.set('afterId', String(aid));
  }
  const res = await fetch(
    `${SUPABASE_URL}/functions/v1/deploy-events-stream?${qs.toString()}`,
    {
      headers: {
        apikey: SUPABASE_ANON_KEY,
        Authorization: `Bearer ${bearerToken}`,
      },
    },
  );

  if (!res.ok) {
    const t = await res.text();
    throw new Error(t || `HTTP ${res.status}`);
  }

  const reader = res.body.getReader();
  const dec = new TextDecoder();
  let buf = '';
  let terminalEvent = null;

  try {
    outer: while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += dec.decode(value, { stream: true });
      let sep;
      while ((sep = buf.indexOf('\n\n')) >= 0) {
        const block = buf.slice(0, sep);
        buf = buf.slice(sep + 2);
        for (const line of block.split('\n')) {
          if (!line.startsWith('data: ')) continue;
          const json = line.slice(6).trim();
          try {
            const ev = JSON.parse(json);
            if (ev.error) {
              console.error('stream:', ev.error);
              throw new Error(String(ev.error));
            }
            if (ev.event_type) {
              const ts = ev.created_at || '';
              console.log(`[${ts}] ${formatDeployEventForConsole(ev)}`);
              if (TERMINAL_DEPLOY_EVENTS.has(String(ev.event_type))) {
                terminalEvent = ev;
                break outer;
              }
            }
          } catch (e) {
            if (e instanceof SyntaxError) {
              console.log(json);
            } else {
              throw e;
            }
          }
        }
      }
    }
  } finally {
    try {
      await reader.cancel();
    } catch {
      // ignore
    }
  }

  return { terminalEvent };
}

/**
 * Upload a single asset file to the project via the upload-file Edge function.
 * Uses a pre-obtained Supabase access token.
 */
async function uploadAssetWithToken(accessToken, projectId, filePath, filename) {
  const fs = require('fs');
  const mime = require('./mime');

  const bytes = fs.readFileSync(filePath);
  const mimeType = mime.fromFilename(filename);

  const formData = new FormData();
  formData.append('file', new Blob([bytes], { type: mimeType }), filename);
  formData.append('project_id', String(projectId));

  const res = await fetch(`${SUPABASE_URL}/functions/v1/upload-file`, {
    method: 'POST',
    headers: {
      'apikey': SUPABASE_ANON_KEY,
      'Authorization': `Bearer ${accessToken}`,
    },
    body: formData,
  });

  const text = await res.text();
  let data = null;
  try { data = text ? JSON.parse(text) : null; } catch { data = { raw: text }; }
  if (!res.ok) {
    const msg = (data && (data.error || data.message)) || `HTTP ${res.status}`;
    const err = new Error(msg);
    err.status = res.status;
    throw err;
  }
  return data;
}

/**
 * Upload all assets from the local `assets/` directory for a project.
 * Skips files that already exist on the server (matched by filename).
 * Returns the count of files uploaded.
 */
async function uploadAssetsWithToken(accessToken, projectId, cwd, onProgress) {
  const path = require('path');
  const { listAssetsFromDir } = require('./parser');

  const assetFiles = listAssetsFromDir(cwd);
  if (assetFiles.length === 0) return 0;

  // Fetch existing filenames so we can skip unchanged files
  const listRes = await fetch(
    `${SUPABASE_URL}/functions/v1/list-files?project_id=${encodeURIComponent(projectId)}`,
    {
      headers: {
        'apikey': SUPABASE_ANON_KEY,
        'Authorization': `Bearer ${accessToken}`,
      },
    },
  );
  const listData = listRes.ok ? await listRes.json() : null;
  const existing = new Set((listData?.files || []).map((f) => f.filename));

  let uploaded = 0;
  for (const filename of assetFiles) {
    if (existing.has(filename)) continue;
    const filePath = path.join(cwd, 'assets', filename);
    await uploadAssetWithToken(accessToken, projectId, filePath, filename);
    if (onProgress) onProgress(filename);
    uploaded++;
  }
  return uploaded;
}

/**
 * Parse `.page` source content via the build compiler and insert a new build row, using a
 * pre-obtained Supabase access token (e.g. from exchangeDeployTokenForAccessToken).
 * Returns the created build row (`{ id, number, status }`).
 */
async function pushWithToken(accessToken, projectId, rawContent, buildCompilerUrl) {
  const { BUILD_COMPILER_URL } = require('./config');
  const url = buildCompilerUrl || BUILD_COMPILER_URL;

  const parseRes = await fetch(`${url}/parse`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${accessToken}`,
    },
    body: JSON.stringify({
      text: rawContent,
      project_id: projectId,
      version: '2',
    }),
  });
  if (!parseRes.ok) {
    const t = await parseRes.text();
    throw new Error(`Parser error: ${t}`);
  }
  const jsonContent = await parseRes.json();

  const insertUrl = `${SUPABASE_URL}/rest/v1/builds`;
  const build = await requestWithToken(
    'POST',
    insertUrl,
    {
      project_id: projectId,
      raw_content: rawContent,
      json_content: jsonContent,
      status: 'draft',
      parser_version: '2',
    },
    accessToken,
    { 'Prefer': 'return=representation' },
  );

  return Array.isArray(build) ? build[0] : build;
}

/**
 * Exchange a project deploy token for a short-lived Supabase access JWT (project owner).
 * `projectUuid` is the project UUID from `.micropage/project.json` (`projectUuid` field).
 * Response includes `project_id` (internal id) used for subsequent API calls.
 */
async function exchangeDeployTokenForAccessToken(deployTokenPlaintext, projectUuid, expiresInSeconds) {
  const ttl =
    expiresInSeconds != null && Number.isFinite(Number(expiresInSeconds))
      ? Math.min(3600, Math.max(60, Math.trunc(Number(expiresInSeconds))))
      : undefined;
  const body = { projectUuid: String(projectUuid).trim() };
  if (ttl != null) body.expiresInSeconds = ttl;

  const res = await fetch(`${SUPABASE_URL}/functions/v1/exchange-deploy-token`, {
    method: 'POST',
    headers: {
      apikey: SUPABASE_ANON_KEY,
      Authorization: `Bearer ${deployTokenPlaintext}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  let data = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = { raw: text };
  }
  if (!res.ok) {
    const err = new Error(
      (data && (data.error || data.message)) || text || `HTTP ${res.status}`,
    );
    err.status = res.status;
    err.data = data;
    throw err;
  }
  if (!data?.access_token) {
    const err = new Error('exchange-deploy-token: missing access_token in response');
    err.data = data;
    throw err;
  }
  if (data.project_id == null || !Number.isFinite(Number(data.project_id))) {
    const err = new Error('exchange-deploy-token: missing project_id in response');
    err.data = data;
    throw err;
  }
  return data;
}

/** Publish a build using a Supabase access JWT (e.g. from exchangeDeployTokenForAccessToken). */
async function invokePublishBuild(accessToken, projectId, buildId) {
  const res = await fetch(`${SUPABASE_URL}/functions/v1/publish-build`, {
    method: 'POST',
    headers: {
      apikey: SUPABASE_ANON_KEY,
      Authorization: `Bearer ${accessToken}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ projectId: Number(projectId), buildId: Number(buildId) }),
  });
  const text = await res.text();
  let data = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = { raw: text };
  }
  if (!res.ok) {
    const err = new Error(
      (data && (data.error || data.message)) || text || `HTTP ${res.status}`,
    );
    err.status = res.status;
    err.data = data;
    throw err;
  }
  return data;
}

module.exports = {
  db,
  fn,
  getUserInfo,
  handleAuthError,
  getValidAccessToken,
  getMaxDeployEventIdForBuild,
  streamDeployEventsUntilDone,
  exchangeDeployTokenForAccessToken,
  pushWithToken,
  invokePublishBuild,
};
