'use strict';

const { execSync } = require('child_process');
const { db, handleAuthError } = require('../supabase');
const { getProjectConfig } = require('../auth');
const { APP_URL } = require('../config');

function projectUrl(domain) {
  if (!domain) return null;
  if (domain.startsWith('http')) return domain;
  return `https://${domain}.pages.dev`;
}

function copyToClipboard(text) {
  const cmds = [
    'xclip -selection clipboard',
    'xsel --clipboard --input',
    'wl-copy',
    'pbcopy',
  ];
  for (const cmd of cmds) {
    const [prog] = cmd.split(' ');
    try {
      execSync(`which ${prog}`, { stdio: 'ignore' });
      execSync(cmd, { input: text });
      return true;
    } catch {
      // try next
    }
  }
  return false;
}

async function getProject(cwd) {
  const config = getProjectConfig(cwd);
  if (!config?.projectId) {
    console.error('Not in a project folder. Run from a folder with .micropage/project.json');
    process.exit(1);
  }

  try {
    const project = await db
      .from('projects')
      .select('id,name,domain')
      .eq('id', config.projectId)
      .single();
    return project || config;
  } catch (err) {
    handleAuthError(err);
    // Fall back to cached config
    return config;
  }
}

// micropage preview  – open the live site in the browser
async function preview() {
  const cwd = process.cwd();
  const project = await getProject(cwd);
  const url = projectUrl(project.domain);

  if (!url) {
    console.error('No domain set for this project. Publish first.');
    process.exit(1);
  }

  console.log(url);
  try {
    const { default: open } = await import('open');
    await open(url);
  } catch {
    console.log('(Could not open browser automatically)');
  }
}

// micropage copy-link  – copy project URL to clipboard
async function copyLink() {
  const cwd = process.cwd();
  const project = await getProject(cwd);
  const url = projectUrl(project.domain);

  if (!url) {
    console.error('No domain set for this project. Publish first.');
    process.exit(1);
  }

  console.log(url);
  const copied = copyToClipboard(url);
  if (copied) {
    console.log('URL copied to clipboard.');
  } else {
    console.log('(Could not copy to clipboard – copy manually above)');
  }
}

// micropage open-pricing  – open the pricing page in the browser
async function openPricing() {
  const url = `${APP_URL}/pricing`;
  console.log(url);
  try {
    const { default: open } = await import('open');
    await open(url);
  } catch {
    console.log('(Could not open browser automatically)');
  }
}

module.exports = { preview, copyLink, openPricing };
