# dotfiles

[mise](https://mise.jdx.dev/) `[dotfiles]` + `mise bootstrap` — shell environment, editor,
multiplexer, git, AI agents, SSH, and security tooling. One unified config; **work**
(`MISE_ENV=work`) overrides git identity (MoonPay git URL rewrites, work signingkey);
**personal** is the default.

## Philosophy

These dotfiles manage **configuration and CLI tooling** you want everywhere.
Project-specific language stacks still belong in per-repo **mise** (`mise.toml`) or other
project tools.

## Install

```bash
curl https://mise.run | sh
mise trust -y dotfiles/mise.toml
mise bootstrap        # from within this directory; installs tools, applies dotfiles,
                       # runs the macOS Brewfile task if applicable
```

Work machine: `export MISE_ENV=work` first (or `mise bootstrap -E work`) to load
`mise.work.toml`'s identity overrides.

On NixOS hosts this all runs automatically on every activation
(`nix/system/mise-dotfiles.nix`) from a Nix store copy of this directory, scoped to just
the dotfiles step (`mise bootstrap --only dotfiles`) so it doesn't touch Nix-managed
packages or user accounts.

### macOS

Install [Homebrew](https://brew.sh/) first. `mise bootstrap`'s final custom-task step runs
`brew bundle install --no-upgrade --file Brewfile` (see `[tasks.bootstrap]` in
`mise.toml`) — no separate script. Ghostty is configured under `~/.config/ghostty/config`;
install the app via Homebrew Cask if you use it.

## Layout

Plain, `$HOME`-mirrored paths (`.config/git/config`, not chezmoi's `dot_config/...`
encoding) — mise's `[dotfiles]` defaults to mirroring the home-relative target path under
this directory. Everything actually deployed is declared explicitly in `mise.toml`'s
`[dotfiles]` table (an allow-list); anything not listed there (this README, `Brewfile`,
`skills/`, `ergodox/`, `AGENTS.md`) simply never leaves the repo.

| Path | Purpose |
|------|---------|
| `mise.toml` | `[dotfiles]` table, `[vars]` (personal identity), permissions hook, macOS bootstrap task |
| `mise.work.toml` | Work-identity `[vars]` overrides, loaded via `MISE_ENV=work` |
| `mise-global-config.toml` | Deployed to `~/.config/mise/config.toml` — global tool versions + the 5 pinned zsh plugins (`http:` backend) |
| `.config/git/config`, `.ssh/config`, `.gnupg/gpg.conf`, `.config/ghostty/config`, `.config/zsh/.zshrc` | Templated (Tera) — OS/WSL/work-personal conditionals |
| `.local/bin/` | Shell helpers (`yeet`, `tm`, …) |
| `skills/` | Agent skills source; `mise.toml` deploys the whole directory to `~/.agents/skills`, `~/.claude/skills`, and `~/.gemini/config/skills` |

## Validation

```bash
mise dotfiles apply --dry-run
mise run lint    # shellcheck via the repo-root mise.toml's dotfiles-scoped tasks
```

## Credits

ty @amcleodca, @burke, @dantecatalfamo, and @malob
