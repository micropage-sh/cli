# cli backlog

Deferred ideas — pick up when relevant.

- [x] **`micropage posts` command — author posts as local markdown.** Shipped: `posts push` (non-destructive upsert-by-slug), `posts pull`, `posts list`, `posts rm <slug>`. Front-matter drives both web and email (title, slug, description, visibility, hero, email, list, subject, preview). Backed by new `upsert-post`/`delete-post` edge functions; images (companion file, `hero:`, and body `![]()` refs) auto-upload + rewrite to stable `R2_PUBLIC_URL/{r2_key}` URLs via `get-file-url?public=true`.

- [x] **`posts push`/`publish`/`unpublish` lifecycle split (behavior change from the released v2.1.0).** `posts push` is now save-only — it upserts content via `upsert-post` and never sends email, even for posts with `email: true` in front-matter (that's now stored as config only, resolved via `form_id`). Reports `saved (draft)` / `saved (live)` instead of `created`/`updated`/`emailed`. New `posts publish [slug]` (one slug, or all local posts if omitted) calls `publish-post`: marks the post live (sets `published_at` on first publish only) and (re)sends email to the active subscriber list for email-configured posts — repeatable, each call re-sends. New `posts unpublish <slug>` calls `unpublish-post`: clears `published_at`, post drops off the site but remains a draft (not deleted). `posts list`/`pull` now show/select `published_at` (Draft vs Published). **Release-notes flag:** anyone relying on the old `posts push` semantics (upsert = live + auto-email) must switch to `posts push` (save) followed by `posts publish` to get the old all-in-one behavior.

- [ ] **`posts publish -w` — multi-post watch terminates early.** `posts publish` auto-triggers a rebuild of the project's active build, and `-w/--watch` streams that rebuild's deploy events (added alongside the "rebuild auto-queued" messaging). When publishing *multiple* posts at once, the stream captures one event cursor up front and exits on the first rebuild's terminal `deployment.completed`, which can happen before later posts' rebuilds deploy — so `--watch` may report "live" slightly early. Exact for the common single-slug case. Fix idea: only promise "until live" for a single target, or track/await one rebuild per published slug.

- [ ] **Pinpoint the `micropage publish -w` stack-trace-on-success.** Reported on a custom-domain
  project (thesantafeweekender.com / project 84): a Ruby/HTML backtrace printed to stdout on an
  otherwise-successful publish. Could not reproduce on a default `*.micropage.sh` project — the default
  path prints clean. A defensive guard now bounds/one-lines payload output in the deploy-event stream
  (`src/supabase.js` `truncateForConsole` + HTML-chunk skip), which should stop the flood, but the exact
  triggering event (likely a non-fatal custom-domain-wiring or webhook error carrying a backtrace) still
  wants pinning from a real captured `-w` run on a custom-domain project.

- [ ] **`posts push` — offer to sync deletions.** Today drift (remote posts with no local file) is only reported, never deleted (by design — filesystem is not the source of truth). Consider a `--prune` flag that, after confirmation, `rm`s remote posts absent locally, for users who do want the folder to be authoritative.
- [x] **Add CLI tests for the `posts` group.** Done: `test/posts-helpers.test.js` (node:test) covers `slugify`, `defaultSlugFromFilename`, `frontMatterFromPost` round-trip, and `findCompanionImage`; the pure helpers are now exported from `src/commands/posts.js` and `npm test` runs `node --test test/`.
  - [ ] Follow-up: `resolveBodyImages`/`resolveHeroImage` aren't unit-tested (they call into `./supabase`); the body-image regex is currently covered by a *copy* of `MD_IMAGE_RE` + the local-ref guard in the test, which can silently drift. Extract a small pure `isLocalImageRef(ref)` (and/or the regex) into a testable helper imported by both `posts-assets.js` and the test to close the gap.
