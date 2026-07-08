status:: accepted
date:: 2026-07-08
deciders:: [[jawn]]
supersedes:: the renderer choice in [[ADR/0009 Logseq wiki on Cloudflare Pages]]
tags:: adr

- # Context
	- [[ADR/0009 Logseq wiki on Cloudflare Pages]] chose the official `logseq/publish-spa` action as the renderer. In practice it clones and compiles the entire Logseq frontend (yarn + ClojureScript) in CI — ~20 minutes on a cold cache — and the pinned 2024-era release (`v0.3.1`) sets up **Node 18** and leaves it on `PATH`, which broke the very first production deploy: wrangler 4 requires Node ≥ 20. The published site was also a multi-megabyte SPA for what is fundamentally a documentation site.
- # Decision
	- Replace the renderer with a **first-party static site generator**: `apps/wiki` — ~400 lines of TypeScript run by **Bun**, with shiki as the only dependency.
	- It renders the Logseq subset this wiki actually uses: outline blocks, `[[wikilinks]]` with a linked-references panel, namespaces with sub-page listings, `key:: value` properties (ADR `status::` gets colored chips), `#tags` with tag pages, tables, and dual-theme highlighted code — plus a ⌘K search index and a canvas force-directed **graph view**.
	- Deploys run `bun x wrangler pages deploy` — bun brings its own runtime, so the Node-version dance disappears. The hosting decision (Cloudflare Pages, wiki.lolwtf.ca, public) from ADR/0009 is unchanged, and `docs/` remains a normal Logseq graph — the editing workflow is untouched.
- # Consequences
	- Builds take about **a second** instead of ~20 minutes; CI is checkout + `bun install` + one script.
	- Full control over markup, theme, and payload — the site is a few hundred KB of static HTML.
	- We own a parser: it covers the constructs used today, but Logseq features we don't use (block refs `((…))`, embeds, `{{query}}`) are **unsupported** — avoid them in `docs/`, or extend `apps/wiki/build.ts` first.
	- The authentic Logseq SPA (and its native graph UI) is gone; the custom graph view at `/graph/` fills that niche.
- # Links
	- [[ADR/0009 Logseq wiki on Cloudflare Pages]], [[Contributing]], `apps/wiki/README.md`
