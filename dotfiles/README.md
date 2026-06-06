# dotfiles

[chezmoi](https://www.chezmoi.io/) + [mise](https://mise.jdx.dev/) — shell environment, editor, multiplexer, git, AI agents, SSH, and security tooling. One unified config; **work** uses username `jpulsifer` (MoonPay git + extra MCP servers); **personal** uses `jawn`.

## Philosophy

These dotfiles manage **configuration and CLI tooling** you want everywhere. Project-specific language stacks still belong in per-repo **mise** (`mise.toml`) or other project tools.

## Install

Clone this repo and run `./install` (installs [mise](https://mise.jdx.dev/) if needed, runs `mise install` from `mise.toml` for chezmoi and repo tools, symlinks the source tree, then `chezmoi apply`).

Or manually:

1. Install [mise](https://mise.jdx.dev/) (or let `run_once_install-mise` install it on first `chezmoi apply`).
2. `mise install` in this repo (installs chezmoi from `mise.toml`).
3. Clone and point chezmoi at the repo (or use `chezmoi init --apply <repo>`), then `chezmoi apply`.

On Linux, if your login shell is not zsh, the install script warns and offers `chsh -s $(command -v zsh) $USER`.

On first apply, scripts install mise (if missing), run `brew bundle install --no-upgrade --file Brewfile` on macOS, run `mise install` for `~/.config/mise/config.toml`, and merge AI agent JSON (Claude/Cursor) via `.chezmoiscripts/`.

### macOS

Install [Homebrew](https://brew.sh/). Ghostty is configured under `~/.config/ghostty/config`; install the app via Homebrew Cask if you use it.

## Layout

| Path | Purpose |
|------|---------|
| `dot_gitconfig.tmpl`, MCP `*.tmpl` | Work machine = user `jpulsifer` (git URL rewrites, extra MCP, Homebrew block); else `jawn` |
| `.chezmoiexternal.yaml` | kube-ps1 + k8s-workflow-utils archives |
| `dot_config/mise/config.toml.tmpl` | Global mise tools |
| `dot_config/zsh/` | Zsh; plugins via [`.chezmoiexternal.yaml`](.chezmoiexternal.yaml) (pure, fzf-tab, autosuggestions, syntax-highlighting) |
| `private_dot_local/private_bin/` | Shell helpers (`yeet`, `tm`, …) |
| `skills/` | Agent skills source; wrappers deploy to `~/.agents`, `~/.claude`, `~/.config/opencode` |

## Validation

```bash
chezmoi apply --dry-run
shellcheck private_dot_local/private_bin/executable_* .chezmoiscripts/run_once_*.sh .chezmoiscripts/run_once_install-opencode.sh 2>/dev/null || true
```

## Credits

ty @amcleodca, @burke, @dantecatalfamo, and @malob
