status:: accepted
date:: 2026-07-08
deciders:: [[jawn]]
tags:: adr

- # Context
	- Documentation was scattered across `CLAUDE.md`, per-module READMEs, and loose files in `docs/`, with no home for decision records. Runbooks especially need to be readable **when the infrastructure is down**, which rules out hosting the docs on the clusters they document. The repo is public, so the docs can be too.
- # Decision
	- `docs/` becomes a **Logseq graph** (`pages/`, `journals/`, `logseq/`): edited with the Logseq desktop app or as plain markdown, linked densely, with ADRs as a `[[ADR]]` namespace carrying `status::`/`date::` page properties.
	- CI (`.github/workflows/wiki.yml`) builds it with the official `logseq/publish-spa` action on every merge touching `docs/**` and direct-uploads it to **Cloudflare Pages** (`wrangler pages deploy`), served publicly at **wiki.lolwtf.ca**. The Pages project, custom domain, and DNS record are Terraform-managed in `terraform/network/cloudflare/wiki.tf`.
- # Consequences
	- Docs survive cluster outages (Cloudflare hosts them) and GitHub Pages stays dedicated to `pulsifer.ca` — the two deploys never touch.
	- The wiki is public: **nothing decrypted ever goes in `docs/`**; the SOPS discipline extends to prose.
	- The published site is a static SPA with linked references, graph view, and search; the trade-off is a heavier JS payload than a plain static site.
	- One-time setup: the `CLOUDFLARE_API_TOKEN` Actions secret (Pages:Edit scope) and an Atlantis apply of the Pages project must precede the first deploy.
	- Alternatives considered: in-cluster hosting (rejected — circular dependency with the infra it documents), GitHub Pages subpath under pulsifer.ca (rejected — two workflows sharing one `gh-pages` branch clobber each other), plain static renderers like Hugo/Quartz (rejected — Logseq outline syntax renders poorly outside Logseq).
- # Links
	- Renderer superseded by [[ADR/0010 First-party Bun SSG for the wiki]] — `publish-spa` pins Node 18 on `PATH` (incompatible with wrangler 4) and takes ~20 min per cold build. Hosting, domain, and graph layout here still stand.
	- [[Contributing]], [[Architecture/GitOps]]
