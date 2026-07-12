status:: accepted
date:: 2026-07-12
deciders:: [[jawn]]
tags:: adr

- # Context
	- Dotfiles (`dotfiles/`, see [[ADR/0006 Dotfiles vendored in-repo with chezmoi]]) were
	  chezmoi-managed — a second templating/deployment tool alongside mise, which this repo
	  already relies on for toolchain management everywhere else. mise's 2026.6 releases
	  added declarative `[dotfiles]` management and `mise bootstrap`, closing most of the
	  gap with chezmoi's feature set and making a single-tool story viable across NixOS,
	  macOS, the WSL image, and ephemeral dev environments.
- # Decision
	- Fully replace chezmoi with mise's `[dotfiles]` + `mise bootstrap` — no hybrid, no
	  chezmoi remnant. Where mise lacked a chezmoi feature outright, the need was
	  restructured away rather than shimmed:
		- `dotfiles/` is flat, plain `$HOME`-mirrored paths (not chezmoi's `dot_config/...`
		  encoding) — matches mise's default source-mirroring convention. `.chezmoiignore` is
		  gone with no replacement; mise's `[dotfiles]` table is an explicit allow-list, so
		  repo-only files simply never get an entry.
		- `dotfiles/mise.toml` holds the `[dotfiles]` table and `[vars]` for personal git
		  identity; `dotfiles/mise.work.toml` overrides those vars when `MISE_ENV=work` is
		  set — replacing chezmoi's OS-username inference with an explicit per-machine
		  opt-in.
		- The 5 pinned zsh plugins (chezmoi externals, tag-archive tarballs) become `http:`
		  backend tool entries in the deployed global mise config, resolved at shell-start
		  via `mise where` — not the `github` backend (Release-assets only, doesn't fit tag
		  archives).
		- `~/.ssh`/`~/.gnupg` permissions (chezmoi's `private_` prefix) have no
		  `[dotfiles]`-native equivalent — a `[bootstrap.hooks].post-dotfiles` hook chmods
		  them instead, verified to fire under the scoped `mise bootstrap --only dotfiles`
		  NixOS uses.
		- The Brewfile stays as-is (mise's `[bootstrap.packages]` brew backend doesn't read
		  Brewfiles and has no cask/tap support), invoked from a `[tasks.bootstrap]` task that
		  `mise bootstrap` runs automatically as its final step.
		- `nix/system/chezmoi.nix` → `nix/system/mise-dotfiles.nix`, using the flake's own
		  `inputs.mise` package and `mise bootstrap --only dotfiles` (not full `mise
		  bootstrap`, to avoid its `user`/packages/repos steps colliding with NixOS's
		  declarative user/package management).
		- `dotfiles/install` is deleted outright; onboarding is
		  `curl https://mise.run | sh && mise trust -y dotfiles/mise.toml && mise bootstrap`.
- # Consequences
	- One templating/deployment tool (mise) instead of two across the whole fleet.
	- Ephemeral/web dev environments (Claude Code web) stay mise-only, no dotfiles applied
	  — unchanged from before this migration; that hook is scoped to this infra repo's own
	  dev environment, not a dotfiles delivery target.
	- mise's `[dotfiles]`/`bootstrap` were ~5 weeks old at time of research (graduated out
	  of `MISE_EXPERIMENTAL=1` in v2026.7.4) — some behavior (e.g. whether
	  `strip_components` auto-detects) didn't match documentation and needed empirical
	  verification against a real install rather than trusting the docs alone.
	- Rollback: NixOS hosts via `nixos-rebuild --rollback`; a mid-migration Mac has no
	  special tooling, just `git checkout` the pre-migration `dotfiles/` commit and run the
	  old flow if needed (nothing auto-reapplies there, unlike NixOS).
	- Future direction (not yet decided, out of scope here): mise eventually managing all
	  AI-agent tooling fleet-wide, with Nix/Brew shrinking to system-only packages.
- # Links
	- [[ADR/0006 Dotfiles vendored in-repo with chezmoi]] (superseded), [[Architecture/NixOS]]
