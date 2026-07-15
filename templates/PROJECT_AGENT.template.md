# Project agent guide (Micropage CLI)

This project was created with the Micropage CLI and is designed to be friendly to local AI agents and automation.

## Key files and layout

- `landing.page` — primary page file. Treat this as the canonical entrypoint for the site.
- `*.page` — additional page files. They are merged in alphabetical order after `landing.page` when pushing.
- `examples/` — curated examples showing different layouts and components:
  - `startup-landing.page` — SaaS / product launch landing page with hero, feature grid, pricing, contact form, and an `img: <- product-dashboard` keyword image.
  - `portfolio.page` — minimal portfolio layout for designers/developers; good reference for text-heavy sections and project lists.
  - `mobile-app-landing.page` — mobile app landing template (PocketTrack) with app-style hero, feature bullets, and platform download buttons.
  - `components-hero-variants.page` — multiple hero section variants (single CTA, image + copy, centered hero).
  - `components-pricing-and-forms.page` — pricing table (three tiers) and a richer contact/quote form, including an `img: <- pricing-cards` example.
- `assets/logo.svg` and `assets/favicon.svg` — default logo and favicon for new projects (uploaded on push). `.page` files reference the stored filename: `logo: <- logo.svg` / `favicon: <- favicon.svg`.
- `posts/` — post files (blog/newsletter content), one Markdown file per post. See "Posts" below.

## Posts

Each file in `posts/*.md` is one post: YAML front-matter + a Markdown body, pushed with `micropage posts push`.

```markdown
---
title: Launching our new dashboard
slug: launching-new-dashboard   # optional; defaults to the filename minus a leading date prefix and .md
description: A quick look at what's new.
visibility: listed              # listed | unlisted | none (default: listed)
hero: launch-hero.png           # optional; local file, existing uploaded asset filename, or absolute URL
email: true                     # optional; send to a subscriber list (default: false)
list: Newsletter                # required when email is true; must match a newsletter form name exactly
subject: We just shipped something new
preview: See what's new in this release
---

Body content in Markdown. Local image refs like `![alt](screenshot.png)` are
uploaded automatically and rewritten to hosted URLs on push.
```

A companion image file next to the post (`posts/launch.md` + `posts/launch.png`) is used as the hero automatically, taking priority over `hero:` in front-matter.

Commands:
- `micropage posts push` — upload local `posts/*.md` (create or update by slug); never deletes remote posts.
- `micropage posts pull` — write remote posts to local `posts/*.md` files.
- `micropage posts list` — list remote posts.
- `micropage posts rm <slug>` — delete a post remotely (local file is untouched).

## How to propose edits safely

- Prefer editing existing `.page` files instead of introducing new formats.
- Keep the Micropage DSL valid — follow the patterns used in the `examples/` folder.
- When creating alternative versions of a section, consider:
  - Copying the original block into `examples/` and annotating it there.
  - Proposing a diff-style change rather than rewriting entire files.

## Reference documentation

For full documentation of the Micropage format and features, see:

- `https://docs.micropage.sh`

You can use the examples in this project as concrete references when generating or modifying `.page` content.
