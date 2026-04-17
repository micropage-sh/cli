'use strict';

const fs = require('fs');
const path = require('path');
const {
  db,
  fn,
  handleAuthError,
  streamDeployEventsUntilDone,
  getMaxDeployEventIdForBuild,
  exchangeDeployTokenForAccessToken,
  uploadAssetsWithToken,
  pushWithToken,
  invokePublishBuild,
} = require('../supabase');
const { getProjectConfig, setProjectConfig } = require('../auth');
const { fetchProjectByUserRef, fetchProjectFromConfig } = require('../project-ref');
const { writePageFile } = require('../parser');
const { formatTable, formatDate } = require('../utils');
const { syncAssets } = require('./files');

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function projectUrl(host) {
  if (!host) return '-';
  if (host.startsWith('http://') || host.startsWith('https://')) return host;
  return `https://${host}`;
}

function copyIfExists(src, dest) {
  try {
    if (fs.existsSync(src)) {
      fs.copyFileSync(src, dest);
    }
  } catch {
    // best-effort; ignore copy errors for templates
  }
}

function copyExamplesAndAssetsIntoProject(dir) {
  const templatesRoot = path.join(__dirname, '..', '..', 'templates');
  const examplesSrc = path.join(templatesRoot, 'examples');
  const assetsSrc = path.join(templatesRoot, 'assets');

  const examplesDest = path.join(dir, 'examples');
  if (!fs.existsSync(examplesDest)) {
    fs.mkdirSync(examplesDest, { recursive: true });
  }

  // Copy example .page files
  try {
    const files = fs.readdirSync(examplesSrc);
    for (const file of files) {
      if (!file.endsWith('.page')) continue;
      const src = path.join(examplesSrc, file);
      const dest = path.join(examplesDest, file);
      copyIfExists(src, dest);
    }
  } catch {
    // ignore if templates/examples missing in this build
  }

  // Default logo / favicon in assets/ (uploaded on push as logo.svg / favicon.svg; examples use `logo: <- logo.svg`)
  const destAssets = path.join(dir, 'assets');
  if (!fs.existsSync(destAssets)) {
    fs.mkdirSync(destAssets, { recursive: true });
  }
  copyIfExists(path.join(assetsSrc, 'logo.svg'), path.join(destAssets, 'logo.svg'));
  copyIfExists(path.join(assetsSrc, 'favicon.svg'), path.join(destAssets, 'favicon.svg'));
}

async function getLatestBuild(projectId) {
  return db
    .from('builds')
    .select('id,number,status,updated_at,failure_reason,archive_url,raw_content')
    .eq('project_id', projectId)
    .order('number', 'desc')
    .limit(1)
    .single();
}

async function pullStorageSync(cwd) {
  const r = await syncAssets(cwd, { quiet: true, prune: true });
  if (r.errors.length > 0) {
    for (const e of r.errors) {
      console.error(`Asset sync failed (${e.name}): ${e.message}`);
    }
    process.exit(1);
  }
  if (r.downloaded > 0 || r.removed > 0) {
    console.log(
      `Synced storage → assets/ (${r.downloaded} file(s) written, ${r.removed} removed locally).`,
    );
  }
}

// ---------------------------------------------------------------------------
// project list
// ---------------------------------------------------------------------------

async function list(options = {}) {
  let projects;
  try {
    projects = await db
      .from('projects')
      .select('id,uuid,name,domain,custom_domain,status,created_at')
      .order('id', 'desc')
      .get();
  } catch (err) {
    handleAuthError(err);
    console.error('Failed to list projects:', err.message);
    process.exit(1);
  }

  if (!Array.isArray(projects) || projects.length === 0) {
    console.log('No projects.');
    return;
  }

  if (options.json) {
    console.log(JSON.stringify(projects, null, 2));
    return;
  }

  // Fetch latest build for each project in one query
  const ids = projects.map((p) => p.id);
  let allBuilds = [];
  try {
    allBuilds = await db
      .from('builds')
      .select('project_id,number,status,updated_at')
      .in('project_id', ids)
      .order('number', 'desc')
      .get();
  } catch {
    // builds query is best-effort
  }

  const latestBuild = {};
  for (const b of allBuilds || []) {
    if (!latestBuild[b.project_id]) latestBuild[b.project_id] = b;
  }

  const rows = projects.map((p) => {
    const build = latestBuild[p.id];
    const url = projectUrl(p.custom_domain || p.domain);
    return [
      p.uuid || '-',
      p.name || '-',
      url,
      build ? `v${build.number} ${build.status}` : '-',
    ];
  });

  formatTable(rows, ['UUID', 'Name', 'URL', 'Latest build']);
}

// ---------------------------------------------------------------------------
// project show / info
// ---------------------------------------------------------------------------

async function show(uuidOrDomain, options = {}) {
  const cwd = process.cwd();
  let project;
  try {
    if (uuidOrDomain != null && String(uuidOrDomain).trim() !== '') {
      project = await fetchProjectByUserRef(db, uuidOrDomain);
    } else {
      const config = getProjectConfig(cwd);
      if (!config?.projectId && !config?.projectUuid) {
        console.error(
          'Not in a project folder and no argument given. Run from a folder with .micropage/project.json or pass a project UUID or domain.',
        );
        process.exit(1);
      }
      project = await fetchProjectFromConfig(db, config);
    }
  } catch (err) {
    handleAuthError(err);
    console.error('Failed to fetch project:', err.message);
    process.exit(1);
  }

  if (!project) {
    console.error('Project not found:', uuidOrDomain != null && String(uuidOrDomain).trim() !== '' ? uuidOrDomain : '(from .micropage/project.json)');
    process.exit(1);
  }

  const build = await getLatestBuild(project.id).catch(() => null);

  if (options.json) {
    console.log(JSON.stringify({ ...project, latest_build: build }, null, 2));
    return;
  }

  const url = projectUrl(project.custom_domain || project.domain);

  console.log('UUID:         ', project.uuid || '-');
  console.log('Name:         ', project.name || '-');
  console.log('Domain:       ', project.domain || '-');
  console.log('Custom domain:', project.custom_domain || '-');
  console.log('URL:          ', url);
  console.log('Created:      ', formatDate(project.created_at));
  if (build) {
    console.log('Build:        ', `v${build.number}`);
    console.log('Build status: ', build.status);
    console.log('Updated:      ', formatDate(build.updated_at));
    if (build.failure_reason) {
      console.log('Failure:      ', build.failure_reason);
    }
  }
}

// ---------------------------------------------------------------------------
// project create
// ---------------------------------------------------------------------------

async function create(name, options = {}) {
  const payload = { name };
  if (options.domain) {
    payload.domain = options.domain;
  }

  let project;
  try {
    const result = await db.from('projects').insert(payload);
    project = Array.isArray(result) ? result[0] : result;
  } catch (err) {
    handleAuthError(err);
    console.error('Failed to create project:', err.message);
    if (err.data) console.error(JSON.stringify(err.data));
    process.exit(1);
  }

  const cwd = process.cwd();
  const dir = path.join(cwd, name);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

  setProjectConfig(dir, {
    projectId: project.id,
    ...(project.uuid ? { projectUuid: project.uuid } : {}),
    domain: project.domain,
    name: project.name || name,
  });
  fs.mkdirSync(path.join(dir, 'assets'), { recursive: true });

  copyExamplesAndAssetsIntoProject(dir);

  // PROJECT_AGENT metadata for local agents and tools
  try {
    const agentTemplate = path.join(__dirname, '..', '..', 'templates', 'PROJECT_AGENT.template.md');
    if (fs.existsSync(agentTemplate)) {
      const contents = fs.readFileSync(agentTemplate, 'utf8');
      fs.writeFileSync(path.join(dir, 'PROJECT_AGENT.md'), contents, 'utf8');
    }
  } catch {
    // best-effort; safe to continue if agent metadata cannot be written
  }

  console.log('Created project:', project.name || name);
  if (project.uuid) console.log('UUID:', project.uuid);
  console.log('URL:', projectUrl(project.domain));
  console.log('Folder:', dir);
  console.log(`\nNext: cd ${name} && touch landing.page && micropage push`);
}

// ---------------------------------------------------------------------------
// project pull  (remote latest build -> local landing.page)
// ---------------------------------------------------------------------------

async function pull(options = {}) {
  const cwd = process.cwd();
  const config = getProjectConfig(cwd);
  if (!config?.projectId) {
    console.error('Not in a project folder. Run from a folder with .micropage/project.json');
    process.exit(1);
  }

  let build;
  try {
    build = await getLatestBuild(config.projectId);
  } catch (err) {
    handleAuthError(err);
    console.error('Failed to fetch build:', err.message);
    process.exit(1);
  }

  if (!build) {
    console.log('No builds found for this project. Create content locally and run: micropage push');
    try {
      await pullStorageSync(cwd);
    } catch (err) {
      handleAuthError(err);
      console.error('Asset sync failed:', err.message);
      process.exit(1);
    }
    return;
  }

  if (!build.raw_content) {
    console.log(`Build v${build.number} has no raw content to pull.`);
    try {
      await pullStorageSync(cwd);
    } catch (err) {
      handleAuthError(err);
      console.error('Asset sync failed:', err.message);
      process.exit(1);
    }
    return;
  }

  const dest = writePageFile(cwd, build.raw_content);
  setProjectConfig(cwd, { ...config, buildId: build.id });

  console.log(`Pulled build v${build.number} (${build.status}) → ${dest}`);
  try {
    await pullStorageSync(cwd);
  } catch (err) {
    handleAuthError(err);
    console.error('Asset sync failed:', err.message);
    process.exit(1);
  }
}

// ---------------------------------------------------------------------------
// project fetch (legacy: clone remote project to local folder)
// ---------------------------------------------------------------------------

async function fetch(uuidOrDomain) {
  if (!uuidOrDomain) {
    console.error('Usage: micropage projects fetch <uuid|domain>');
    process.exit(1);
  }

  let project;
  try {
    project = await fetchProjectByUserRef(db, uuidOrDomain);
  } catch (err) {
    handleAuthError(err);
    if (err.status === 404 || !project) {
      console.error('Project not found:', uuidOrDomain);
    } else {
      console.error('Failed to fetch project:', err.message);
    }
    process.exit(1);
  }

  if (!project) {
    console.error('Project not found:', uuidOrDomain);
    process.exit(1);
  }

  const name = project.name || project.domain || project.uuid || String(project.id);
  const cwd = process.cwd();
  const dir = path.join(cwd, name);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

  setProjectConfig(dir, {
    projectId: project.id,
    ...(project.uuid ? { projectUuid: project.uuid } : {}),
    domain: project.domain,
    name: project.name || name,
  });
  fs.mkdirSync(path.join(dir, 'assets'), { recursive: true });

  // Optionally pull latest build content
  const build = await getLatestBuild(project.id).catch(() => null);
  if (build?.raw_content) {
    writePageFile(dir, build.raw_content);
    setProjectConfig(dir, {
      projectId: project.id,
      ...(project.uuid ? { projectUuid: project.uuid } : {}),
      domain: project.domain,
      name: project.name || name,
      buildId: build.id,
    });
    console.log(`Fetched project: ${name} (build v${build.number}) → ${dir}`);
    if (project.uuid) console.log('UUID:', project.uuid);
  } else {
    console.log('Fetched project:', name);
    console.log('Folder:', dir);
    if (project.uuid) console.log('UUID:', project.uuid);
  }

  try {
    await pullStorageSync(dir);
  } catch (err) {
    handleAuthError(err);
    console.error('Asset sync failed:', err.message);
    process.exit(1);
  }
}

// ---------------------------------------------------------------------------
// project delete
// ---------------------------------------------------------------------------

async function deleteProject(options = {}) {
  const readline = require('readline');
  const cwd = process.cwd();
  const config = getProjectConfig(cwd);
  if (!config?.projectId && !config?.projectUuid) {
    console.error('Not in a project folder. Run from a folder with .micropage/project.json');
    process.exit(1);
  }

  let remoteProjectId = config.projectId;
  if (remoteProjectId == null && config.projectUuid) {
    try {
      const row = await db
        .from('projects')
        .select('id')
        .eq('uuid', String(config.projectUuid).trim())
        .single();
      remoteProjectId = row?.id;
    } catch (err) {
      handleAuthError(err);
      console.error('Failed to resolve project:', err.message);
      process.exit(1);
    }
  }
  if (remoteProjectId == null) {
    console.error('Could not determine project id for deletion. Re-fetch or recreate .micropage/project.json.');
    process.exit(1);
  }

  if (!options.yes) {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    const label = config.name || config.projectUuid || config.projectId;
    const answer = await new Promise((resolve) => {
      rl.question(
        `Delete project "${label}" (remote + local .micropage)? [y/N] `,
        (a) => { rl.close(); resolve((a || '').trim().toLowerCase()); }
      );
    });
    if (answer !== 'y' && answer !== 'yes') {
      console.log('Aborted.');
      return;
    }
  }

  try {
    await fn.invoke('delete-project', { projectId: remoteProjectId });
    console.log('Project deletion initiated on server (cleanup may continue in the background).');
  } catch (err) {
    handleAuthError(err);
    if (err.status === 404) {
      console.log('Project already removed on server.');
    } else {
      console.error('Delete failed:', err.message);
      process.exit(1);
    }
  }

  const configPath = path.join(cwd, '.micropage');
  if (fs.existsSync(configPath)) {
    fs.rmSync(configPath, { recursive: true });
    console.log('Removed local .micropage/');
  }
}

/**
 * CI deploy using a project deploy token. No Micropage login required.
 *
 * Without --build: reads .page files from the current directory, parses them,
 * creates a new build, then publishes. This is the standard CI flow.
 *
 * With --build <id>: publishes an existing build by id (e.g. to redeploy a
 * specific snapshot without touching files).
 */
async function deploy(projectUuid, deployToken, options = {}) {
  if (!deployToken) {
    console.error('A deploy token is required. Usage: micropage projects deploy [projectUuid] <token>');
    process.exit(1);
  }

  if (!projectUuid) {
    const config = getProjectConfig(process.cwd());
    if (!config?.projectUuid) {
      console.error('No project UUID found. Either pass it as the first argument or run from a project directory.');
      process.exit(1);
    }
    projectUuid = config.projectUuid;
  }

  try {
    const exchanged = await exchangeDeployTokenForAccessToken(
      deployToken,
      projectUuid,
      options.exchangeTtl,
    );
    const accessToken = exchanged.access_token;
    const internalProjectId = exchanged.project_id;

    let buildId = options.build;

    if (buildId === undefined || buildId === null || String(buildId).trim() === '') {
      // No --build supplied: read .page files from CWD and create a new build.
      const cwd = process.cwd();
      const { readPageFilesFromDir } = require('../parser');

      let rawContent;
      try {
        rawContent = readPageFilesFromDir(cwd);
      } catch (err) {
        console.error('Failed to read .page files:', err.message);
        process.exit(1);
      }

      if (!rawContent || !rawContent.trim()) {
        console.error('No content found in .page files. Run from a folder with .page source files.');
        process.exit(1);
      }

      // Upload new assets from assets/ before parsing
      try {
        const uploaded = await uploadAssetsWithToken(
          accessToken,
          internalProjectId,
          cwd,
          (filename) => console.log(`Uploaded asset: ${filename}`),
        );
        if (uploaded > 0) console.log(`Uploaded ${uploaded} asset(s).`);
      } catch (err) {
        console.error('Asset upload failed:', err.message);
        process.exit(1);
      }

      console.log('Parsing content and creating build…');
      let build;
      try {
        build = await pushWithToken(accessToken, internalProjectId, rawContent);
      } catch (err) {
        console.error('Build creation failed:', err.message);
        process.exit(1);
      }

      buildId = build.id;
      console.log(`Build v${build.number} created (id: ${buildId}).`);
    }

    console.log('Publishing…');
    const deployEventCursor = await getMaxDeployEventIdForBuild(buildId, accessToken);
    await invokePublishBuild(accessToken, internalProjectId, buildId);
    console.log('Deploy triggered for build', buildId);

    if (options.watch) {
      console.log('');
      console.log('Build / deploy events:');
      const streamToken = options.watchWithDeployToken ? deployToken : accessToken;
      const { terminalEvent } = await streamDeployEventsUntilDone(
        streamToken,
        internalProjectId,
        buildId,
        { afterId: deployEventCursor },
      );
      if (terminalEvent?.event_type === 'build.failed') {
        const msg =
          (terminalEvent.payload && (terminalEvent.payload.error || terminalEvent.payload.message)) ||
          'Build failed';
        console.error(msg);
        process.exit(1);
      }
    }
  } catch (err) {
    console.error('Deploy failed:', err.message);
    process.exit(1);
  }
}

module.exports = { list, show, create, pull, fetch, deleteProject, deploy };
