# cli backlog

Deferred ideas — pick up when relevant.

- [x] **`micropage posts` command — author posts as local markdown.** Shipped: `posts push` (non-destructive upsert-by-slug), `posts pull`, `posts list`, `posts rm <slug>`. Front-matter drives both web and email (title, slug, description, visibility, hero, email, list, subject, preview). Backed by new `upsert-post`/`delete-post` edge functions; images (companion file, `hero:`, and body `![]()` refs) auto-upload + rewrite to stable `R2_PUBLIC_URL/{r2_key}` URLs via `get-file-url?public=true`.

- [ ] **`posts push` — offer to sync deletions.** Today drift (remote posts with no local file) is only reported, never deleted (by design — filesystem is not the source of truth). Consider a `--prune` flag that, after confirmation, `rm`s remote posts absent locally, for users who do want the folder to be authoritative.
- [ ] **Add CLI tests for the `posts` group.** No tests currently: front-matter parse/round-trip, slug derivation (`defaultSlugFromFilename`/`slugify`), and `posts-assets` image resolution (companion vs `hero:` vs existing-asset vs URL passthrough) + the `MD_IMAGE_RE` body rewrite / unresolved-ref reporting are all untested. Reviewer flagged this as the weakest part of the feature.
