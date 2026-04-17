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

## How to propose edits safely

- Prefer editing existing `.page` files instead of introducing new formats.
- Keep the Micropage DSL valid — follow the patterns used in the `examples/` folder.
- When creating alternative versions of a section, consider:
  - Copying the original block into `examples/` and annotating it there.
  - Proposing a diff-style change rather than rewriting entire files.

## Reference documentation

For full documentation of the Micropage format and features, see:

- `https://docs.micropage.sh`

You can use the examples in this project as concrete references when generating or modifying `.page` content.*** End Patch***}"/>
