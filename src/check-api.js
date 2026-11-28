'use strict';

const { BUILD_COMPILER_URL } = require('./config');

const TIMEOUT_MS = 60000;

class CheckError extends Error {
  constructor(code, message, status = null) {
    super(message);
    this.name = 'CheckError';
    this.code = code;
    this.status = status;
  }
}

function serverMessage(text) {
  try {
    const data = JSON.parse(text);
    if (data && typeof data.error === 'string' && data.error) return data.error;
  } catch {
    // not JSON
  }
  return '';
}

function errorFor(status, text) {
  const msg = serverMessage(text);
  if (status === 404) {
    return new CheckError('CHECK_UNSUPPORTED', "This build compiler doesn't support check yet.", status);
  }
  if (status === 401) {
    return new CheckError('CHECK_UNAUTHORIZED', 'Session expired or not valid. Run: micropage login', status);
  }
  if (status === 403) {
    return new CheckError('CHECK_FORBIDDEN', 'This project belongs to another account, or you are logged in as someone else.', status);
  }
  if (status >= 500) {
    return new CheckError('CHECK_SERVER', `The build compiler failed (HTTP ${status}). Try again shortly.`, status);
  }
  return new CheckError('CHECK_REJECTED', msg || `The build compiler refused the check (HTTP ${status}).`, status);
}

/**
 * Ask the build compiler for diagnostics on `text` without saving anything:
 * /check creates no build, registers no forms and fetches no remote images.
 * `localFiles` names files in assets/ that a push would upload, so references
 * to them aren't reported as missing.
 *
 * Resolves to `{ diagnostics }`; rejects with a CheckError (or the auth error
 * from getToken when not logged in).
 */
async function checkContent({ text, projectId, localFiles, getToken, refresh } = {}) {
  let supabase;
  const loadSupabase = () => (supabase = supabase || require('./supabase'));
  const token = getToken || (() => loadSupabase().getValidAccessToken());
  const refreshToken = refresh || (() => loadSupabase().refreshSession());

  const body = { text, project_id: projectId };
  if (Array.isArray(localFiles)) body.local_files = localFiles;
  const payload = JSON.stringify(body);

  const send = async (accessToken) => {
    try {
      return await fetch(`${BUILD_COMPILER_URL}/check`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${accessToken}`,
        },
        body: payload,
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
    } catch (err) {
      const reason = err?.name === 'TimeoutError' ? 'timed out' : err?.cause?.code || err?.message || 'network error';
      throw new CheckError('CHECK_NETWORK', `Could not reach the build compiler (${reason}).`);
    }
  };

  let res = await send(await token());
  // One silent refresh covers a token that expired server-side just before
  // the local expiry check would have caught it.
  if (res.status === 401) {
    const refreshed = await refreshToken().catch(() => null);
    if (refreshed?.access_token) res = await send(refreshed.access_token);
  }

  const raw = await res.text().catch(() => '');
  if (!res.ok) throw errorFor(res.status, raw);

  let data;
  try {
    data = JSON.parse(raw);
  } catch {
    data = null;
  }
  if (!data || !Array.isArray(data.diagnostics)) {
    throw new CheckError('CHECK_BAD_RESPONSE', 'The build compiler returned an unexpected response.', res.status);
  }
  return { diagnostics: data.diagnostics.filter((d) => d && typeof d === 'object' && !Array.isArray(d)) };
}

module.exports = { checkContent, CheckError };
