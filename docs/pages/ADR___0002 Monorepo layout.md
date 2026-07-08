status:: accepted
date:: 2025 (backfilled 2026-07-08)
deciders:: [[jawn]]
tags:: adr

- # Context
	- Infrastructure, applications, images, and dotfiles were spread across multiple repos and an aging `systems/` layout. Cross-cutting changes needed coordinated PRs in several places, Renovate coverage was fragmented, and app → image → deployment wiring crossed repo boundaries.
- # Decision
	- One monorepo with a layer-per-directory layout:
		- `nix/` — bare metal, `clusters/` — Kubernetes, `terraform/` — cloud & network, `apps/` + `packages/` + `images/` — first-party code and OCI images, `dotfiles/` — chezmoi source.
	- External `jonpulsifer/*` repos get vendored **with history** (`git filter-repo`; the `onboard-repo` skill codifies it) rather than submoduled.
	- TypeScript packages form a root Bun workspace; `containers.yml` builds images from any of the three code directories.
- # Consequences
	- A change can move an app, its chart, and its deployment in one reviewable PR.
	- One Renovate config and one CI surface; workflows must be path-scoped to stay fast.
	- The repo is public, so everything in it — including this wiki — is written as public content.
	- Repo size and CI matrix grow over time; path filters and dynamic discovery (e.g. `terraform.yml`) keep it manageable.
- # Links
	- [[Architecture]], [[Architecture/Applications]], [[ADR/0006 Dotfiles vendored in-repo with chezmoi]]
