# micropage CLI

Command-line interface for [micropage.sh](https://app.micropage.sh) — create, edit, publish, and manage microsites from your terminal.

## Requirements

- Node.js ≥ 18
- A micropage.sh account

## Installation

### Homebrew (macOS / Linux)

```bash
brew tap micropage-sh/tap
brew install micropage
```

### npm

```bash
npm install -g micropage
```

## Authentication

Authenticate with your browser (GitHub or magic link):

```bash
micropage login        # opens browser for authentication
micropage whoami       # show the currently logged-in user and subscription
micropage logout       # clear the stored session
```

## Project workflow

```bash
# Create a new project and initialise a local folder
micropage projects create my-site

cd my-site

# Edit landing.page (or any *.page file) with your content
nano landing.page

# Push local content as a draft build
micropage push

# Publish the current draft (deploys to Cloudflare Pages)
micropage publish

# Pull the latest remote build content to landing.page
micropage projects pull

# Open the live site in the browser
micropage preview

# Copy the live URL to clipboard
micropage copy-link
```

### Project domains

When you create a project without `-d`, the API assigns `projects.domain` as the initial host for your site (for example `my-site.micropage.sh`). You can optionally attach a custom domain (such as `www.example.com`) in the web editor; when present, the CLI shows that custom domain as the site URL (otherwise the default host).

### Authoring posts

Posts live in the project's `posts/` folder as Markdown files with YAML front-matter:

```markdown
---
title: Hello, world
slug: hello
description: A short summary for the archive, meta description, and og tags.
visibility: listed
hero: ./hello.jpg
list: newsletter
subject: Hello, world!
preview: The first post on this site.
---

Body content goes here as standard Markdown.
```

`title` is required. `slug` defaults to the filename minus a leading `YYYY-MM-DD-` date prefix. `visibility` is `listed` (default, appears in the site's `/content` index) or `unlisted`. `list` names a newsletter form and is required to email the post on publish. Local image references in the body are auto-uploaded and rewritten to hosted URLs on `push`.

```bash
# Save posts/hello.md as a draft
micropage posts push

# Publish it (and email the `list:` target, if set)
micropage posts publish hello

# Take it back down (stays as a draft)
micropage posts unpublish hello
```

See [`micropage posts`](#posts) below for the full command set.

## Commands reference

### Auth

| Command | Description |
|---|---|
| `micropage login [--force]` | Authenticate via browser |
| `micropage logout` | Clear stored session |
| `micropage whoami` | Show logged-in user and subscription/plan |

### Projects

| Command | Description |
|---|---|
| `micropage projects list [--json]` | List your projects |
| `micropage projects show [id] [--json]` | Show project + latest build details |
| `micropage projects create <name> [-d domain]` | Create a project and init local folder. Omit `-d` to let the API assign `{slugified-name}-{6 hex}` (unique Pages/DNS label, max 58 chars). Use `-d` only to override the slug. |
| `micropage projects fetch <uuid\|domain>` | Fetch an existing project and init local folder (includes storage → `./assets` sync) |
| `micropage projects pull` | Pull latest build raw content → `landing.page`, then sync `./assets` with project storage (1:1) |
| `micropage projects delete [-y]` | Delete project (remote + local `.micropage/`) |
| `micropage projects deploy <uuid> <token> [-w]` | CI: read `.page` files, create build, and publish with a deploy token (Pro+). No login. |

When you create a new project, the CLI also scaffolds:

- an `examples/` directory with multiple starter `.page` files (full sites and component-only patterns),
- default `logo.svg` and `favicon.svg` under `assets/` (referenced by the examples as `logo: <- logo.svg` / `favicon: <- favicon.svg`),
- a `PROJECT_AGENT.md` file that explains the layout for local tools and agents, and links to the docs at `https://docs.micropage.sh`.

### Builds

| Command | Description |
|---|---|
| `micropage push` | Merge local `.page` files and save as a draft build |
| `micropage publish` | Push then deploy to Cloudflare Pages |
| `micropage builds list [--json]` | List builds for the current project |
| `micropage builds redeploy [version]` | Re-publish an older build as a new deploy |
| `micropage builds download [version] [-o file]` | Download a deployed build archive as a `.zip` file |

**Notes:**

- Archives are only available for **deployed** builds.
- If you omit `version`, the CLI downloads the latest deployed build.
- The first time you request an archive for a build, the server may need a short time to prepare it; the CLI will wait and then download once ready.
- By default the archive is saved as `build-v<version>.zip` in the current directory; use `-o` to change the output path.

### Links

| Command | Description |
|---|---|
| `micropage preview` | Open the live site in the browser |
| `micropage copy-link` | Copy the live URL to clipboard |
| `micropage open-pricing` | Open the pricing page in the browser |

### Posts

| Command | Description |
|---|---|
| `micropage posts push` | Save local `posts/*.md` files as post drafts (or update already-published posts, which go live immediately) |
| `micropage posts publish [slug]` | Publish a post (or all local posts) to the web; sends the newsletter email if the post has a `list:`. Re-running re-sends the email. |
| `micropage posts unpublish <slug>` | Remove a post's `/content/<slug>` page; the post remains as a draft |
| `micropage posts pull` | Pull remote posts down to local `posts/*.md` files |
| `micropage posts list` | List the project's posts (slug, title, visibility, emailed, status, created) |
| `micropage posts rm <slug>` | Delete a post entirely (remote) |

**Note:** `micropage posts publish` publishes a single *post*. It's distinct from `micropage publish`, which pushes and deploys the *site*.

### Files

| Command | Description |
|---|---|
| `micropage files list [--json]` | List uploaded project files |
| `micropage files url <filename> [--copy]` | Get (and optionally copy) a file URL |
| `micropage files sync [-q]` | Download every file from project storage into `./assets` (matches remote list; removes extra local files) |

### Form submissions

| Command | Description |
|---|---|
| `micropage submissions list [--json]` | List form submissions for the project |
| `micropage submissions show <id> [--json]` | Show a single submission in detail |
| `micropage submissions export [--format csv|json] [-o file]` | Export all form submissions for the current project |

**Examples:**

- Export to CSV in the current directory:

  ```bash
  micropage submissions export
  ```

- Export to a custom CSV path:

  ```bash
  micropage submissions export --output exports/contact-form.csv
  ```

- Export as JSON:

  ```bash
  micropage submissions export --format json --output submissions.json
  ```

## Local content model

The CLI uses one or more `*.page` files in the working directory as the source of truth for project content.

**Merge order when pushing:**
1. `landing.page` (canonical primary file)
2. Any additional `*.page` files, sorted alphabetically
3. Files are joined with a single blank line between them

**Pulling** always writes to `landing.page` only.

## Project configuration

Each project folder has a `.micropage/project.json` file that stores:
- `projectId` — the Supabase project ID
- `buildId` — the ID of the last draft/deployed build (auto-updated by push/pull)
- `domain` — the Cloudflare Pages domain
- `name` — the project name

Add `.micropage/` to your `.gitignore` if you share the content folder.

## Machine-readable output

Most list and detail commands accept a `--json` flag to output raw JSON, which is useful for scripting.

```bash
micropage projects list --json | jq '.[].name'
micropage builds list --json | jq '.[] | select(.status == "deployed") | .number'
```
