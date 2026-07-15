#!/usr/bin/env node
'use strict';

const { Command } = require('commander');
const { version } = require('../package.json');

const login = require('./commands/login');
const logout = require('./commands/logout');
const whoami = require('./commands/whoami');
const projects = require('./commands/projects');
const builds = require('./commands/builds');
const submissions = require('./commands/submissions');
const forms = require('./commands/forms');
const files = require('./commands/files');
const links = require('./commands/links');
const posts = require('./commands/posts');

const program = new Command();

program
  .name('micropage')
  .description('CLI for micropage.sh – create, sync, and publish microsites')
  .version(version);

// ---------------------------------------------------------------------------
// Authentication
// ---------------------------------------------------------------------------

program
  .command('login')
  .description('Authenticate via the browser')
  .option('-f, --force', 'Re-authenticate even if already logged in')
  .action((opts) => login.run(opts));

program
  .command('logout')
  .description('Clear the stored session')
  .action(() => logout.run());

program
  .command('whoami')
  .description('Show the currently logged-in user and subscription')
  .action(() => whoami.run());

// ---------------------------------------------------------------------------
// Projects  (micropage projects <subcommand>)
// ---------------------------------------------------------------------------

const projectCmd = program.command('projects').description('Manage projects');

projectCmd
  .command('list')
  .description('List your projects')
  .option('--json', 'Output as JSON')
  .action((opts) => projects.list(opts));

projectCmd
  .command('show [uuidOrDomain]')
  .description('Show project details including latest build info (UUID or domain; omit from a project folder)')
  .option('--json', 'Output as JSON')
  .action((uuidOrDomain, opts) => projects.show(uuidOrDomain, opts));

projectCmd
  .command('create <name>')
  .description('Create a new project and init local folder')
  .option(
    '-d, --domain <domain>',
    'Override Cloudflare Pages project name / slug (default: server generates name-slug + 6 hex, max 58 chars)',
  )
  .action((name, opts) => projects.create(name, opts));

projectCmd
  .command('fetch <uuidOrDomain>')
  .description('Fetch an existing project by UUID or domain, init local folder')
  .action((ref) => projects.fetch(ref));

projectCmd
  .command('pull')
  .description('Pull latest build raw content → local landing.page')
  .action(() => projects.pull());

projectCmd
  .command('delete')
  .description('Delete project (remote + local .micropage/)')
  .option('-y, --yes', 'Skip confirmation prompt')
  .action((opts) => projects.deleteProject(opts));

projectCmd
  .command('publish')
  .description('Push local content and publish (deploy to Cloudflare Pages) — alias for `micropage publish`')
  .option('-w, --watch', 'Stream build/deploy events after triggering publish')
  .action((opts) => builds.publish(opts));

projectCmd
  .command('deploy [projectUuid] [token]')
  .description(
    'CI publish using a deploy token (Pro+). No login required. ' +
    'projectUuid is optional when run from a project directory (reads from .micropage/project.json). ' +
    'Without --build: reads .page files in the current directory, creates a build, and publishes. ' +
    'With --build <id>: publishes an existing build by id.',
  )
  .option('-b, --build <id>', 'Publish a specific existing build id instead of creating one from .page files')
  .option('-w, --watch', 'Stream build/deploy events until finished or failed')
  .option(
    '--exchange-ttl <seconds>',
    'Exchanged access JWT lifetime in seconds (60–3600; omit for server default)',
    (v) => parseInt(String(v), 10),
  )
  .option(
    '--watch-with-deploy-token',
    'Use the deploy token for the event stream instead of the exchanged JWT',
  )
  .action((projectUuid, token, opts) => {
    // If only one positional arg was given, it is the token; read UUID from project config.
    if (token === undefined) {
      return projects.deploy(null, projectUuid, opts);
    }
    return projects.deploy(projectUuid, token, opts);
  });

// ---------------------------------------------------------------------------
// Builds  (micropage builds <subcommand>)
// ---------------------------------------------------------------------------

const buildCmd = program.command('builds').description('Manage builds');

buildCmd
  .command('list')
  .description('List builds for the current project')
  .option('--json', 'Output as JSON')
  .action((opts) => builds.list(opts));

buildCmd
  .command('redeploy [version]')
  .description('Set active build to a version and republish (no new build row)')
  .action((version) => builds.redeploy(version));

buildCmd
  .command('download [version]')
  .description('Download a build archive (zip) locally')
  .option('-o, --output <file>', 'Output file path')
  .action((version, opts) => builds.download(version, opts));

// ---------------------------------------------------------------------------
// Top-level push / publish (most common workflow commands)
// ---------------------------------------------------------------------------

program
  .command('push')
  .description('Merge local .page files and save as a draft build')
  .action(() => builds.push());

program
  .command('publish')
  .description('Push local content and publish (deploy to Cloudflare Pages)')
  .option('-w, --watch', 'Stream build/deploy events after triggering publish')
  .action((opts) => builds.publish(opts));

// ---------------------------------------------------------------------------
// Links
// ---------------------------------------------------------------------------

program
  .command('preview')
  .description('Open the project live URL in the browser')
  .action(() => links.preview());

program
  .command('copy-link')
  .description('Copy the project live URL to the clipboard')
  .action(() => links.copyLink());

program
  .command('open-pricing')
  .description('Open the pricing page in the browser')
  .action(() => links.openPricing());

// ---------------------------------------------------------------------------
// Files  (micropage files <subcommand>)
// ---------------------------------------------------------------------------

const filesCmd = program.command('files').description('Manage project files');

filesCmd
  .command('list')
  .description('List uploaded project files')
  .option('--json', 'Output as JSON')
  .action((opts) => files.list(opts));

filesCmd
  .command('url <filename>')
  .description('Get the URL for an uploaded file')
  .option('--copy', 'Copy the URL to clipboard')
  .action((filename, opts) => files.url(filename, opts));

filesCmd
  .command('sync')
  .description('Download all project files from storage into ./assets (mirrors remote list)')
  .option('-q, --quiet', 'No per-file output or summary (errors still print)')
  .action((opts) => files.sync(opts));

// ---------------------------------------------------------------------------
// Forms  (micropage forms <subcommand>)
// ---------------------------------------------------------------------------

const formCmd = program.command('forms').description('View forms for the current project');

formCmd
  .command('list')
  .description('List forms and their submission counts for the current project')
  .option('--json', 'Output as JSON')
  .action((opts) => forms.list(opts));

// ---------------------------------------------------------------------------
// Form submissions  (micropage submissions <subcommand>)
// ---------------------------------------------------------------------------

const subCmd = program.command('submissions').description('View form submissions');

subCmd
  .command('list')
  .description('List form submissions for the current project')
  .option('--json', 'Output as JSON')
  .action((opts) => submissions.list(opts));

subCmd
  .command('show <id>')
  .description('Show a single form submission in detail')
  .option('--json', 'Output as JSON')
  .action((id, opts) => submissions.show(id, opts));

subCmd
  .command('export')
  .description('Export form submissions for the current project to a file')
  .option(
    '-f, --format <format>',
    'Output format: csv or json (default: csv)',
  )
  .option(
    '-o, --output <file>',
    'Output file path (default: submissions.<format>)',
  )
  .action((opts) => submissions.exportSubmissions(opts));

// ---------------------------------------------------------------------------
// Posts  (micropage posts <subcommand>)
// ---------------------------------------------------------------------------

const postsCmd = program.command('posts').description('Manage posts (dual-channel web + email content)');

postsCmd
  .command('push')
  .description('Upload local posts/*.md as post rows (create or update); reports remote-only posts as drift')
  .action((opts) => posts.push(opts));

postsCmd
  .command('pull')
  .description('Write remote posts to local posts/*.md files')
  .option('-f, --force', 'Overwrite existing local files without prompting')
  .action((opts) => posts.pull(opts));

postsCmd
  .command('list')
  .description('List posts for the current project')
  .option('--json', 'Output as JSON')
  .action((opts) => posts.list(opts));

postsCmd
  .command('rm <slug>')
  .description('Delete a post by slug (remote only; does not touch local files)')
  .action((slug, opts) => posts.rm(slug, opts));

program.parse();
