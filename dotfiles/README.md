# dotfiles

`mise bootstrap` — shell environment, editor, multiplexer, git, AI agents, SSH, and security tooling.
One unified config; **work** (`MISE_ENV=work`) overrides git identity (MoonPay git URL rewrites, work signingkey);
**personal** is the default.

## Philosophy

These dotfiles manage **configuration, user CLI tooling, and AI agent skills** across macOS and Linux/NixOS.

- **Homebrew (macOS):** Core shell utilities (`eza`, `fzf`, `neovim`, `bat`, `ripgrep`, `fd`, `git-delta`, `jq`, `gh`, `btop`), Casks (`docker-desktop`, `1password-cli`, `claude-code`, `secretive`), and fonts.
- **Nix (Linux/NixOS):** System closure, daemons, and system CLI packages (`git`, `zsh`, `eza`, `fzf`, `neovim`, `bat`, `ripgrep`, `fd`, `delta`, `jq`, `gh`, `btop`, `mise`).
- **Mise (Cross-platform):** Runtimes (`bun`, `node`), K8s/Cloud tools (`kubectl`, `helm`, `k9s`), AI agent CLIs, Zsh plugins (`http:` backend), and task orchestrator (`mise bootstrap`).

## Install

```bash
curl https://mise.run | sh
mise trust -y dotfiles/mise.toml
mise bootstrap        # automatically detects OS and runs bootstrap:macos or bootstrap:linux
```

Work machine: `export MISE_ENV=work` first (or `mise bootstrap -E work`) to load
`mise.work.toml`'s identity overrides and activate `.config/git/config.work`.

On NixOS hosts this all runs automatically on every activation
(`nix/system/mise-dotfiles.nix`) via `mise run bootstrap`.

### macOS

Install [Homebrew](https://brew.sh/) first. `mise bootstrap` runs `brew bundle install --no-upgrade --file Brewfile`
followed by `scripts/deploy-dotfiles.sh` to symlink configurations into `$HOME`.

## Layout

| Path | Purpose |
|------|---------|
| `mise.toml` | Task orchestration (`bootstrap`, `bootstrap:macos`, `bootstrap:linux`, `dotfiles:deploy`), `[vars]` (personal identity) |
| `mise.work.toml` | Work-identity `[vars]` overrides, loaded via `MISE_ENV=work` |
| `mise-global-config.toml` | Deployed to `~/.config/mise/config.toml` — global tool versions + pinned zsh plugins (`http:` backend) |
| `scripts/deploy-dotfiles.sh` | Atomic symlink deployer for `$HOME` |
| `.config/git/config` & `.config/git/config.work` | Git settings + native `[includeIf]` for MoonPay repositories |
| `.config/zsh/.zshrc` | Zsh environment with runtime OS and `MISE_ENV` checks |
| `.local/bin/` | Shell helpers (`yeet`, `tm`, …) |
| `skills/` | Agent skills source deployed to `~/.agents/skills`, `~/.claude/skills`, and `~/.gemini/config/skills` |

## Validation

```bash
mise run check   # format check and shellcheck
```

## Credits

ty @amcleodca, @burke, @dantecatalfamo, and @malob
