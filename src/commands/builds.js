'use strict';

const fs = require('fs');
const path = require('path');
const https = require('https');
const http = require('http');
const {
  db,
  fn,
  handleAuthError,
  getValidAccessToken,
  getMaxDeployEventIdForBuild,
  streamDeployEventsUntilDone,
  uploadAssetsWithToken,
} = require('../supabase');
const { getProjectConfig, setProjectConfig } = require('../auth');
const { readPageFilesFromDir, readLlmsTxtFromDir } = require('../parser');
const { BUILD_COMPILER_URL, projectUrl } = require('../config');
const { formatTable, formatDate } = require('../utils');

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** CLI build version args: `16`, `v16`, ` v16 ` → build number; undefined if omitted. */
function parseOptionalBuildNumber(version) {
  if (version === undefined || version === null) return undefined;
  if (typeof version === 'number') {
    if (!Number.isFinite(version)) {
      console.error('Invalid build version. Use a number or vN (e.g. 16 or v16).');
      process.exit(1);
    }
    return version;
  }
  const s = String(version).trim();
  if (s === '') return undefined;
  const n = Number(s.replace(/^v\s*/i, ''));
  if (!Number.isFinite(n)) {
    console.error('Invalid build version. Use a number or vN (e.g. 16 or v16).');
    process.exit(1);
  }
  return n;
}

async function parseContent(rawContent, projectId, buildId) {
  const accessToken = await getValidAccessToken();

  const res = await fetch(`${BUILD_COMPILER_URL}/parse`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${accessToken}`,
    },
    body: JSON.stringify({
      text: rawContent,
      project_id: projectId,
      build_id: buildId || null,
      version: '2',
    }),
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Parser error: ${text}`);
  }
  return res.json();
}

function requireProjectConfig(cwd) {
  const config = getProjectConfig(cwd);
  if (!config?.projectId) {
    console.error('Not in a project folder. Run from a folder with .micropage/project.json');
    process.exit(1);
  }
  return config;
}

async function setActiveBuildId(projectId, buildId) {
  await db.from('projects').eq('id', projectId).update({ active_build_id: buildId });
}

// Remove a draft row created for a push that then failed, so a failed push
// leaves no empty build behind. Best-effort: the push has already failed.
async function discardBuild(buildId) {
  try {
    await fn.invoke('delete-build', { build_id: buildId });
  } catch (err) {
    console.error(`Could not remove the empty draft build (id ${buildId}): ${err.message}`);
  }
}

// ---------------------------------------------------------------------------
// build list
// ---------------------------------------------------------------------------

async function list(options = {}) {
  const cwd = process.cwd();
  const config = requireProjectConfig(cwd);

  let builds;
  try {
    builds = await db
      .from('builds')
      .select('id,number,status,updated_at,failure_reason,archive_url,archive_size_bytes')
      .eq('project_id', config.projectId)
      .order('number', 'desc')
      .get();
  } catch (err) {
    handleAuthError(err);
    console.error('Failed to list builds:', err.message);
    process.exit(1);
  }

  if (!Array.isArray(builds) || builds.length === 0) {
    console.log('No builds for this project.');
    return;
  }

  if (options.json) {
    console.log(JSON.stringify(builds, null, 2));
    return;
  }

  const rows = builds.map((b) => [
    `v${b.number}`,
    b.status,
    formatDate(b.updated_at),
    b.failure_reason ? b.failure_reason.slice(0, 40) : '',
  ]);
  formatTable(rows, ['Version', 'Status', 'Updated', 'Failure reason']);
}

// ---------------------------------------------------------------------------
// push  (merge local files → update/create draft build)
// ---------------------------------------------------------------------------

async function push(options = {}) {
  const cwd = process.cwd();
  const config = requireProjectConfig(cwd);

  let rawContent;
  try {
    rawContent = readPageFilesFromDir(cwd);
  } catch (err) {
    console.error(err.message);
    process.exit(1);
  }

  if (!rawContent.trim()) {
    console.error('No content found in .page files.');
    process.exit(1);
  }

  // Upload new files in assets/ to project Files before parsing,
  // so `img: <- name` lookups can resolve against just-uploaded files.
  try {
    const accessToken = await getValidAccessToken();
    const uploaded = await uploadAssetsWithToken(
      accessToken,
      config.projectId,
      cwd,
      (filename) => console.log(`Uploaded asset: ${filename}`),
    );
    if (uploaded > 0) console.log(`Uploaded ${uploaded} asset(s).`);
  } catch (err) {
    handleAuthError(err);
    console.error('Asset upload failed:', err.message);
    process.exit(1);
  }

  // Pick the target build before parsing so the parser stamps that build's own
  // id into json_content: reuse a draft/failed build, otherwise create a new
  // draft row now and fill in json_content after the parse.
  let existingBuild = null;
  if (config.buildId) {
    try {
      existingBuild = await db.from('builds').select('id,number,status').eq('id', config.buildId).single();
    } catch {
      // build not found – will create new
    }
  }

  const isDraft = existingBuild && (existingBuild.status === 'draft' || existingBuild.status === 'failed');

  let build;
  if (isDraft) {
    build = existingBuild;
  } else {
    try {
      const results = await db.from('builds').insert({
        project_id: config.projectId,
        raw_content: rawContent,
        status: 'draft',
        parser_version: '2',
      });
      build = Array.isArray(results) ? results[0] : results;
    } catch (err) {
      handleAuthError(err);
      console.error('Push failed:', err.message);
      process.exit(1);
    }
    if (!build?.id) {
      console.error('Push failed: the new build was not returned by the server.');
      process.exit(1);
    }
  }

  // Parse content via parser API
  console.log('Parsing content…');
  let jsonContent;
  try {
    jsonContent = await parseContent(rawContent, config.projectId, build.id);
  } catch (err) {
    console.error('Parse failed:', err.message);
    if (!isDraft) await discardBuild(build.id);
    process.exit(1);
  }

  const llmsTxt = readLlmsTxtFromDir(cwd);
  if (llmsTxt != null) {
    jsonContent.site = jsonContent.site || {};
    jsonContent.site.llms_txt = llmsTxt;
    console.log(`Including llms.txt (${Buffer.byteLength(llmsTxt, 'utf8')} bytes).`);
  }

  try {
    if (isDraft) {
      const results = await db
        .from('builds')
        .eq('id', existingBuild.id)
        .update({ raw_content: rawContent, json_content: jsonContent });
      build = Array.isArray(results) ? results[0] : existingBuild;
      console.log(`Updated build v${existingBuild.number}.`);
    } else {
      const results = await db.from('builds').eq('id', build.id).update({ json_content: jsonContent });
      build = (Array.isArray(results) && results[0]) || build;
      console.log(`Created build v${build.number}.`);
    }
  } catch (err) {
    if (!isDraft) await discardBuild(build.id);
    handleAuthError(err);
    console.error('Push failed:', err.message);
    process.exit(1);
  }

  // Persist buildId and align project.active_build_id (editor / publish default)
  setProjectConfig(cwd, { ...config, buildId: build.id });
  try {
    await setActiveBuildId(config.projectId, build.id);
  } catch (err) {
    handleAuthError(err);
    console.error('Failed to set active build:', err.message);
    process.exit(1);
  }
}

// ---------------------------------------------------------------------------
// publish  (push if needed, then trigger publish)
// ---------------------------------------------------------------------------

async function publish(options = {}) {
  const cwd = process.cwd();
  const config = requireProjectConfig(cwd);

  // Always push first to upload latest local content
  if (!options.noPush) {
    console.log('Pushing local content…');
    await push({ ...options, skipPublish: true });
  }

  // Re-read config after push (buildId may have changed)
  const updatedConfig = getProjectConfig(cwd);

  if (!updatedConfig.buildId) {
    console.error('No build ID found after push. Cannot publish.');
    process.exit(1);
  }

  // Fetch live project record to pick up custom_domain (not stored in local config).
  let customDomain = null;
  try {
    const proj = await db
      .from('projects')
      .select('custom_domain')
      .eq('id', updatedConfig.projectId)
      .single();
    customDomain = proj?.custom_domain || null;
  } catch {
    // best-effort; fall back to default domain
  }

  console.log('Publishing…');
  try {
    const eventCursor = await getMaxDeployEventIdForBuild(updatedConfig.buildId);
    await fn.invoke('publish-build', {
      buildId: updatedConfig.buildId,
      projectId: updatedConfig.projectId,
    });
    console.log('Publish triggered. The build will be deployed in a few moments.');
    const viewUrl = projectUrl(updatedConfig.domain, customDomain);
    if (viewUrl) console.log(`View at: ${viewUrl}`);
    if (options.watch) {
      console.log('');
      console.log('Build / deploy events:');
      try {
        const accessToken = await getValidAccessToken();
        const { terminalEvent } = await streamDeployEventsUntilDone(
          accessToken,
          updatedConfig.projectId,
          updatedConfig.buildId,
          { afterId: eventCursor },
        );
        if (terminalEvent?.event_type === 'build.failed') {
          const msg =
            (terminalEvent.payload && (terminalEvent.payload.error || terminalEvent.payload.message)) ||
            'Build failed';
          console.error(msg);
          process.exit(1);
        }
      } catch (streamErr) {
        console.error('Event stream failed:', streamErr.message);
        process.exit(1);
      }
    }
  } catch (err) {
    handleAuthError(err);
    console.error('Publish failed:', err.message);
    process.exit(1);
  }
}

// ---------------------------------------------------------------------------
// build redeploy  (set active build + republish that snapshot, no new row)
// ---------------------------------------------------------------------------

async function redeploy(versionArg, options = {}) {
  const cwd = process.cwd();
  const config = requireProjectConfig(cwd);
  const buildNumber = parseOptionalBuildNumber(versionArg);

  // Find the build by number
  let sourceBuild;
  try {
    if (buildNumber !== undefined) {
      sourceBuild = await db
        .from('builds')
        .select('id,number,status')
        .eq('project_id', config.projectId)
        .eq('number', buildNumber)
        .single();
    } else {
      // Default: use current build
      if (!config.buildId) {
        console.error('No build number specified and no current build ID found.');
        process.exit(1);
      }
      sourceBuild = await db
        .from('builds')
        .select('id,number,status')
        .eq('id', config.buildId)
        .single();
    }
  } catch (err) {
    handleAuthError(err);
    console.error('Failed to find build:', err.message);
    process.exit(1);
  }

  if (!sourceBuild) {
    console.error('Build not found.');
    process.exit(1);
  }

  console.log(`Republishing v${sourceBuild.number} (setting active build)…`);

  try {
    await setActiveBuildId(config.projectId, sourceBuild.id);
  } catch (err) {
    handleAuthError(err);
    console.error('Failed to set active build:', err.message);
    process.exit(1);
  }

  setProjectConfig(cwd, { ...config, buildId: sourceBuild.id });

  try {
    await fn.invoke('publish-build', {
      buildId: sourceBuild.id,
      projectId: config.projectId,
    });
    console.log(`Publish triggered for v${sourceBuild.number}.`);
  } catch (err) {
    handleAuthError(err);
    console.error('Publish failed:', err.message);
    process.exit(1);
  }
}

// ---------------------------------------------------------------------------
// build download
// ---------------------------------------------------------------------------

async function download(versionArg, options = {}) {
  const cwd = process.cwd();
  const config = requireProjectConfig(cwd);
  const buildNumber = parseOptionalBuildNumber(versionArg);

  let build;
  try {
    if (buildNumber !== undefined) {
      build = await db
        .from('builds')
        .select('id,number,status,archive_url,project_id')
        .eq('project_id', config.projectId)
        .eq('number', buildNumber)
        .single();
    } else {
      // Download latest deployed build
      const builds = await db
        .from('builds')
        .select('id,number,status,archive_url,project_id')
        .eq('project_id', config.projectId)
        .eq('status', 'deployed')
        .order('number', 'desc')
        .limit(1)
        .get();
      build = builds?.[0] || null;
    }
  } catch (err) {
    handleAuthError(err);
    console.error('Failed to find build:', err.message);
    process.exit(1);
  }

  if (!build) {
    console.error('No matching build found.');
    process.exit(1);
  }

  if (build.status !== 'deployed') {
    console.error(`Build v${build.number} is not deployed; archives are only available for deployed builds.`);
    process.exit(1);
  }

  const projectIdForArchive = build.project_id != null ? build.project_id : config.projectId;
  const archiveEventCursor = await getMaxDeployEventIdForBuild(build.id);

  const requestArchive = async () => {
    try {
      return await fn.invoke('request-build-archive', {
        buildId: String(build.id),
        projectId: String(projectIdForArchive),
      });
    } catch (err) {
      handleAuthError(err);
      console.error('Failed to invoke request-build-archive:', err.message);
      process.exit(1);
    }
  };

  // Stored archive URLs (builds table, archive.completed payload) can be expired;
  // only a fresh request-build-archive response carries a link that is valid now.
  let downloadLink = null;
  let archiveReady = false;
  const data = await requestArchive();
  if (data?.already_ready && data.archive_url) {
    downloadLink = data.archive_url;
  } else if (data?.queued || data?.pending) {
    console.log('Archive generation queued — streaming progress (zip may take several minutes)…');
    try {
      const accessToken = await getValidAccessToken();
      const { terminalEvent } = await streamDeployEventsUntilDone(
        accessToken,
        projectIdForArchive,
        build.id,
        { afterId: archiveEventCursor, followSuperseded: false },
      );
      if (terminalEvent?.event_type === 'archive.failed') {
        const msg =
          (terminalEvent.payload && (terminalEvent.payload.error || terminalEvent.payload.message)) ||
          'Archive generation failed';
        console.error(msg);
        process.exit(1);
      }
      if (terminalEvent?.event_type === 'archive.completed') {
        archiveReady = true;
      }
    } catch (streamErr) {
      handleAuthError(streamErr);
      console.error('Event stream failed:', streamErr.message);
      process.exit(1);
    }
  } else {
    console.warn('Archive response did not include ready/queued/pending; polling builds table.');
  }

  if (!downloadLink) {
    // Poll builds table until archive_url is populated or timeout.
    const started = Date.now();
    const timeoutMs = 2 * 60 * 1000; // 2 minutes
    const pollIntervalMs = 5000;
    while (!archiveReady && Date.now() - started < timeoutMs) {
      await new Promise((r) => setTimeout(r, pollIntervalMs));
      const rows = await db
        .from('builds')
        .select('id,number,status,archive_url')
        .eq('id', build.id)
        .get();
      const refreshed = rows?.[0];
      if (!refreshed) {
        console.error('Build disappeared while waiting for archive.');
        process.exit(1);
      }
      if (refreshed.status !== 'deployed') {
        console.error(`Build changed status to ${refreshed.status} while waiting for archive; aborting.`);
        process.exit(1);
      }
      build = refreshed;
      if (refreshed.archive_url) archiveReady = true;
    }

    if (!archiveReady) {
      console.error('Timed out waiting for archive to become available.');
      process.exit(1);
    }

    const ready = await requestArchive();
    if (!(ready?.already_ready && ready.archive_url)) {
      console.error('Archive is ready but no download link was returned. Run the command again.');
      process.exit(1);
    }
    downloadLink = ready.archive_url;
  }

  const outFile = options.output || path.join(cwd, `build-v${build.number}.zip`);
  console.log(`Downloading build v${build.number} → ${outFile}`);

  try {
    await downloadUrl(downloadLink, outFile);
  } catch (err) {
    console.error(`${err.message}. Run the command again; if it keeps failing, contact support.`);
    process.exit(1);
  }
  console.log('Download complete.');
}

const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);
const MAX_REDIRECTS = 5;

/**
 * Streams `url` to `dest`. The file is only created once a 200 arrives, and is
 * removed if the transfer fails, so a failed download never leaves a stub file.
 */
function downloadUrl(url, dest, redirectsLeft = MAX_REDIRECTS) {
  return new Promise((resolve, reject) => {
    let settled = false;
    let file = null;

    const fail = (err) => {
      if (settled) return;
      settled = true;
      let cleaned = false;
      const cleanup = () => {
        if (cleaned) return;
        cleaned = true;
        fs.rm(dest, { force: true }, () => reject(err));
      };
      if (file) {
        file.destroy();
        file.once('close', cleanup);
        if (file.closed) cleanup();
      } else {
        reject(err);
      }
    };

    const proto = url.startsWith('https') ? https : http;
    const req = proto.get(url, (res) => {
      if (REDIRECT_STATUSES.has(res.statusCode) && res.headers.location) {
        res.resume();
        if (redirectsLeft <= 0) {
          fail(new Error('Download failed: too many redirects'));
          return;
        }
        settled = true;
        const next = new URL(res.headers.location, url).toString();
        downloadUrl(next, dest, redirectsLeft - 1).then(resolve, reject);
        return;
      }
      if (res.statusCode !== 200) {
        res.resume();
        fail(new Error(`Download failed: HTTP ${res.statusCode}`));
        return;
      }
      file = fs.createWriteStream(dest);
      file.on('error', (err) => {
        res.destroy();
        fail(new Error(`Download failed: ${err.message}`));
      });
      res.on('error', (err) => fail(new Error(`Download failed: ${err.message}`)));
      res.on('aborted', () => fail(new Error('Download failed: connection closed early')));
      res.on('end', () => {
        if (!res.complete) fail(new Error('Download failed: connection closed early'));
      });
      file.on('finish', () => {
        if (settled) return;
        if (!res.complete) {
          fail(new Error('Download failed: connection closed early'));
          return;
        }
        settled = true;
        file.close(() => resolve());
      });
      res.pipe(file);
    });
    req.on('error', (err) => fail(new Error(`Download failed: ${err.message}`)));
  });
}

module.exports = { list, push, publish, redeploy, download, downloadUrl };
