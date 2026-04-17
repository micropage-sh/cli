'use strict';

const http = require('http');
const { randomBytes } = require('crypto');
const { setSession, getSession } = require('../auth');
const { getUserInfo, getValidAccessToken } = require('../supabase');
const { APP_URL, SUPABASE_URL, SUPABASE_ANON_KEY } = require('../config');

// Find an available ephemeral port by briefly binding to port 0.
function getFreePort() {
  return new Promise((resolve, reject) => {
    const server = http.createServer();
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      server.close(() => resolve(port));
    });
    server.on('error', reject);
  });
}

const PAGE_SHELL = (title, body) => `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${title}</title>
  <link rel="preconnect" href="https://fonts.googleapis.com">
  <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
  <link href="https://fonts.googleapis.com/css2?family=Inter:wght@300;400;500;600&display=swap" rel="stylesheet">
  <style>
    *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }

    :root {
      --login-bg: linear-gradient(160deg, #f0f2f5 0%, #e4e8ec 100%);
      --login-card-bg: #ffffff;
      --login-card-border: rgba(0, 0, 0, 0.06);
      --login-card-shadow: 0 8px 24px rgba(0, 0, 0, 0.08);
      --login-heading-color: #1a1a1a;
      --login-text-muted: #6b7280;
    }

    @media (prefers-color-scheme: dark) {
      :root {
        --login-bg: linear-gradient(160deg, #1f2937 0%, #111827 100%);
        --login-card-bg: #374151;
        --login-card-border: rgba(255, 255, 255, 0.08);
        --login-card-shadow: 0 8px 24px rgba(0, 0, 0, 0.4);
        --login-heading-color: #f9fafb;
        --login-text-muted: #9ca3af;
      }
    }

    html, body {
      height: 100%;
      font-family: "Inter", system-ui, sans-serif;
      background: var(--login-bg);
      color: var(--login-heading-color);
    }

    .login-container {
      min-height: 100%;
      display: flex;
      justify-content: center;
      align-items: flex-start;
      padding: 3rem 1rem;
    }

    .login-box {
      background: var(--login-card-bg);
      padding: 2.5rem 3rem;
      border-radius: 12px;
      box-shadow: var(--login-card-shadow);
      border: 1px solid var(--login-card-border);
      text-align: center;
      min-width: 280px;
      max-width: 400px;
      width: 100%;
    }

    .app-brand {
      font-size: 1.8rem;
      margin-bottom: 1.5rem;
      color: var(--login-heading-color);
      font-weight: 300;
    }
    .app-brand strong { font-weight: 600; }

    .login-subtitle {
      color: var(--login-text-muted);
      margin-bottom: 1.5rem;
      font-size: 1rem;
      line-height: 1.5;
    }

    .status-icon {
      font-size: 2.5rem;
      margin-bottom: 1rem;
      line-height: 1;
    }

    .alert {
      border-radius: 8px;
      padding: 0.9rem 1.1rem;
      font-size: 0.9rem;
      margin-bottom: 1rem;
    }
    .alert-success {
      background: #d1fae5;
      color: #065f46;
      border: 1px solid #6ee7b7;
    }
    .alert-danger {
      background: #fee2e2;
      color: #991b1b;
      border: 1px solid #fca5a5;
    }
    @media (prefers-color-scheme: dark) {
      .alert-success { background: #064e3b; color: #6ee7b7; border-color: #065f46; }
      .alert-danger  { background: #7f1d1d; color: #fca5a5; border-color: #991b1b; }
    }

    .hint {
      color: var(--login-text-muted);
      font-size: 0.85rem;
      margin-top: 1rem;
    }
    .hint code {
      background: rgba(0,0,0,0.06);
      border-radius: 4px;
      padding: 0.1em 0.35em;
      font-size: 0.9em;
    }
    @media (prefers-color-scheme: dark) {
      .hint code { background: rgba(255,255,255,0.1); }
    }
  </style>
</head>
<body>
  <div class="login-container">
    <div class="login-box">
      <div class="app-brand"><strong>micro</strong>page</div>
      ${body}
    </div>
  </div>
</body>
</html>`;

const SUCCESS_HTML = PAGE_SHELL(
  'micropage CLI – authenticated',
  `<div class="status-icon">✓</div>
      <div class="alert alert-success">You're logged in!</div>
      <p class="hint">Return to your terminal. You can close this tab.</p>`
);

const ERROR_HTML = (msg) => PAGE_SHELL(
  'micropage CLI – error',
  `<div class="status-icon">✕</div>
      <div class="alert alert-danger">${msg}</div>
      <p class="hint">Close this tab and run <code>micropage login</code> again.</p>`
);

async function run(options = {}) {
  if (!options.force) {
    const existing = getSession();
    if (existing) {
      try {
        await getValidAccessToken();
        const email = existing.user?.email || 'unknown';
        console.log(`Already logged in as ${email}.`);
        console.log('Use --force to re-authenticate.');
        return;
      } catch {
        // Token expired or refresh failed — fall through to re-login
      }
    }
  }

  const state = randomBytes(16).toString('hex');
  const port = await getFreePort();
  const loginUrl = `${APP_URL}/cli-auth?state=${state}&port=${port}`;

  let resolveLogin, rejectLogin;
  const loginPromise = new Promise((res, rej) => {
    resolveLogin = res;
    rejectLogin = rej;
  });

  const server = http.createServer((req, res) => {
    const url = new URL(req.url, `http://127.0.0.1:${port}`);

    if (url.pathname !== '/callback') {
      res.writeHead(404);
      res.end();
      return;
    }

    const receivedState = url.searchParams.get('state');
    const accessToken = url.searchParams.get('access_token');
    const refreshToken = url.searchParams.get('refresh_token');

    if (!receivedState || receivedState !== state) {
      res.writeHead(400, { 'Content-Type': 'text/html' });
      res.end(ERROR_HTML('Invalid state parameter.'));
      rejectLogin(new Error('State mismatch – possible security issue'));
      return;
    }

    if (!accessToken || !refreshToken) {
      res.writeHead(400, { 'Content-Type': 'text/html' });
      res.end(ERROR_HTML('Missing authentication tokens.'));
      rejectLogin(new Error('Missing tokens in callback'));
      return;
    }

    res.writeHead(200, { 'Content-Type': 'text/html' });
    res.end(SUCCESS_HTML);
    resolveLogin({ access_token: accessToken, refresh_token: refreshToken });
  });

  server.listen(port, '127.0.0.1', async () => {
    console.log('Opening browser for authentication…');
    console.log(`If the browser does not open, visit:\n  ${loginUrl}\n`);

    try {
      const { default: open } = await import('open');
      await open(loginUrl);
    } catch {
      // Browser open is best-effort; user can navigate manually.
    }
  });

  const timeout = setTimeout(() => {
    server.close();
    rejectLogin(new Error('Login timed out after 5 minutes. Try again.'));
  }, 5 * 60 * 1000);

  try {
    const { access_token, refresh_token } = await loginPromise;
    clearTimeout(timeout);
    server.close();

    const user = await getUserInfo(access_token);
    setSession({ access_token, refresh_token, user });

    const displayName = user?.email || user?.user_metadata?.user_name || 'unknown';
    console.log(`Logged in as ${displayName}`);
  } catch (err) {
    clearTimeout(timeout);
    server.close();
    console.error('Login failed:', err.message);
    process.exit(1);
  }
}

module.exports = { run };
