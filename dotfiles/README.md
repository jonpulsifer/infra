# dotfiles

`mise bootstrap` — shell environment, editor, multiplexer, git, AI agents, SSH, and security tooling,
on macOS, Linux/NixOS and Windows.
One unified config; **work** (`MISE_ENV=work`) overrides git identity (MoonPay git URL rewrites, work signingkey);
**personal** is the default.

## Philosophy

These dotfiles manage **configuration, user CLI tooling, and AI agent skills** across macOS, Linux/NixOS and Windows.

- **Homebrew (macOS):** Core shell utilities (`eza`, `fzf`, `neovim`, `bat`, `ripgrep`, `fd`, `git-delta`, `jq`, `gh`, `btop`, `sd`), Casks (`docker-desktop`, `1password-cli`, `claude-code`, `secretive`), and fonts.
- **Nix (Linux/NixOS):** System closure and daemons; home-manager-managed shell tooling for the `jawn` user (`eza`, `fzf`, `neovim`, `bat`, `ripgrep`, `fd`, `delta`, `jq`, `gh`, `btop`, `sd`, `1password-cli`) plus zsh plugins (`pure`, `fzf-tab`, `autosuggestions`, `syntax-highlighting`, `kube-ps1`) — see `nix/home/jawn.nix`.
- **Mise (Cross-platform):** Runtimes (`bun`, `node`), K8s/Cloud tools (`kubectl`, `helm`, `k9s`), AI agent CLIs, macOS-only zsh plugins (`http:` backend), and task orchestrator (`mise bootstrap`).
- **WinGet (Windows):** PowerShell 7, Windows Terminal, Git, WSL, 1Password, VS Code and the OS settings, declared as a DSC v3 configuration in `windows/configuration.winget`. Everything else on Windows comes from mise — there is no Homebrew and no home-manager there, so `mise-global-config.toml` carries an `os = ["windows"]` block for the shell tooling those two provide elsewhere.

## Install

```bash
curl https://mise.run | sh
mise trust -y dotfiles/mise.toml
mise bootstrap        # automatically detects OS and runs bootstrap:macos or bootstrap:linux
```

Work machine: `export MISE_ENV=work` first (or `mise bootstrap -E work`) to load
`mise.work.toml`'s identity overrides and activate `.config/git/config.work`.

### Windows

One line, in any PowerShell — it moves itself onto PowerShell 7 if it starts in 5.1:

```powershell
irm https://raw.githubusercontent.com/jonpulsifer/infra/main/dotfiles/windows/bootstrap.ps1 | iex
```

It applies `windows/configuration.winget`, sparse-clones this repo to
`%USERPROFILE%\src\github.com\jonpulsifer\infra`, and runs `mise run bootstrap`, which routes to
`bootstrap:windows`. Add `-WithWsl` to install WSL and import a NixOS distro too.

Windows keeps its own clone. Nothing symlinks across the WSL boundary in either direction —
see [Bootstrap a Windows Desk](../docs/pages/Runbooks___Bootstrap%20a%20Windows%20Desk.md) for why.

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
| `windows/` | The Windows side: installer, winget desired state, PowerShell profile fragments, Terminal settings |

## Validation

```bash
mise run check   # format check, shellcheck, and PSScriptAnalyzer
```

## Credits

ty @amcleodca, @burke, @dantecatalfamo, and @malob
