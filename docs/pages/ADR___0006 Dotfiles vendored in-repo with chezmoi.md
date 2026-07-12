status:: superseded by [[ADR/0011 Migrate dotfiles from chezmoi to mise]]
date:: 2025 (backfilled 2026-07-08)
deciders:: [[jawn]]
tags:: adr

- # Context
	- Dotfiles lived in a standalone `jonpulsifer/dotfiles` repo, creating a second PR surface and a bootstrap dependency (network clone) on fresh hosts. home-manager was considered and rejected as too heavy for what is mostly static config.
- # Decision
	- Merge the dotfiles repo into `dotfiles/` **with history** (`git filter-repo`) and keep them **chezmoi-managed** — not a flake input, no home-manager.
	- The repo-root `.chezmoiroot` points chezmoi at `dotfiles/`. On NixOS hosts, `nix/system/chezmoi.nix` carries the tree into the system closure and an activation script runs `chezmoi apply --source <store-path>` for `jawn` on every rebuild/boot.
- # Consequences
	- No network clone at activation time; dotfiles self-heal on every rebuild and are versioned with the infra that consumes them.
	- Edits under `dotfiles/` ship on the next `chezmoi apply`/rebuild — one repo, one PR.
	- The WSL image needs no build-time seeding; the activation script applies dotfiles on first boot.
	- chezmoi remains usable standalone on non-NixOS machines pointed at the same source.
- # Links
	- [[Architecture/NixOS]], [[ADR/0002 Monorepo layout]]
