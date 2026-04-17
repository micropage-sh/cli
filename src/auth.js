'use strict';

const fs = require('fs');
const path = require('path');

const CONFIG_DIR = path.join(
  process.env.HOME || process.env.USERPROFILE || '',
  '.micropage'
);
const CONFIG_FILE = path.join(CONFIG_DIR, 'config.json');

const PROJECT_CONFIG_DIR = '.micropage';
const PROJECT_CONFIG_FILE = path.join(PROJECT_CONFIG_DIR, 'project.json');

function ensureConfigDir() {
  if (!fs.existsSync(CONFIG_DIR)) {
    fs.mkdirSync(CONFIG_DIR, { recursive: true });
  }
}

function readConfig() {
  try {
    return JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8'));
  } catch {
    return {};
  }
}

function writeConfig(config) {
  ensureConfigDir();
  fs.writeFileSync(CONFIG_FILE, JSON.stringify(config, null, 2), 'utf8');
}

// ---------------------------------------------------------------------------
// Session storage (Supabase access_token + refresh_token)
// ---------------------------------------------------------------------------

function getSession() {
  const config = readConfig();
  if (config.access_token && config.refresh_token) {
    return {
      access_token: config.access_token,
      refresh_token: config.refresh_token,
      user: config.user || null,
    };
  }
  return null;
}

function setSession({ access_token, refresh_token, user }) {
  const config = readConfig();
  config.access_token = access_token;
  config.refresh_token = refresh_token;
  if (user) config.user = user;
  writeConfig(config);
}

function clearSession() {
  const config = readConfig();
  delete config.access_token;
  delete config.refresh_token;
  delete config.user;
  writeConfig(config);
}

// ---------------------------------------------------------------------------
// Legacy token support (deprecated – kept for backward compat messaging)
// ---------------------------------------------------------------------------

function getToken() {
  return readConfig().token || null;
}

function setToken(token) {
  const config = readConfig();
  config.token = token;
  writeConfig(config);
}

function maskToken(token) {
  if (!token || token.length < 8) return token ? '****' : '(none)';
  return token.slice(0, 4) + '****' + token.slice(-4);
}

// ---------------------------------------------------------------------------
// Per-project config (.micropage/project.json)
// ---------------------------------------------------------------------------

function getProjectConfig(cwd = process.cwd()) {
  const filePath = path.join(cwd, PROJECT_CONFIG_FILE);
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch {
    return null;
  }
}

function setProjectConfig(cwd, config) {
  const filePath = path.join(cwd, PROJECT_CONFIG_FILE);
  const dir = path.dirname(filePath);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
  fs.writeFileSync(filePath, JSON.stringify(config, null, 2), 'utf8');
}

module.exports = {
  CONFIG_DIR,
  CONFIG_FILE,
  PROJECT_CONFIG_DIR,
  PROJECT_CONFIG_FILE,
  // Session (new)
  getSession,
  setSession,
  clearSession,
  // Legacy token
  getToken,
  setToken,
  maskToken,
  // Project config
  getProjectConfig,
  setProjectConfig,
};
