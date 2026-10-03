# AGENTS.md

Guidance for AI coding agents working in this directory.

## Repository overview

mise-managed dotfiles (`mise bootstrap`): zsh (pure + plugins — home-manager on NixOS, `http:` backend on macOS, see `mise-global-config.toml`),
PowerShell 7 on Windows (`windows/`), tmux, vim, git, Homebrew / Nix (home-manager) / WinGet / Mise tooling, SSH, GPG, Ghostty, and agent skill deployment.

## Development tools

- **Homebrew (macOS)**: Core shell tools (`eza`, `fzf`, `neovim`, `bat`, `ripgrep`, `fd`, `git-delta`, `jq`, `gh`, `btop`, `sd`), Casks & fonts, plus zsh plugins via the mise `http:` backend.
- **Nix (Linux/NixOS)**: OS system state, system closure, and home-manager-managed shell tooling + zsh plugins for the `jawn` user (`nix/home/jawn.nix`).
- **Mise**: Polyglot runtimes (`bun`, `node`), K8s/Cloud tools (`kubectl`, `helm`, `k9s`), AI agents, macOS zsh plugins, task orchestration (`mise bootstrap`), and profile switching (`MISE_ENV=work`). On Windows it also carries the shell tooling Homebrew and home-manager provide elsewhere, behind an `os = ["windows"]` filter.
- **WinGet (Windows)**: applications and OS settings as a DSC v3 configuration (`windows/configuration.winget`), applied with `winget configure`.

## Build & validation

```bash
mise run check      # from the repo root: shfmt, shellcheck, PSScriptAnalyzer
mise run dotfiles:check   # resolve every link source without deploying
```

## Architecture

- **Bootstrap**: `mise bootstrap` auto-detects OS (`uname -s`) and routes to `bootstrap:macos` or `bootstrap:linux`, running `scripts/deploy-dotfiles.sh` for atomic symlinking. On Windows mise takes the task's `run_windows` branch to `bootstrap:windows`, which runs `windows/deploy-dotfiles.ps1`.
- **The WSL boundary**: Windows and the distro each keep their own clone, and nothing symlinks between them. Do not "simplify" this to one clone — `$PROFILE` must resolve before the WSL VM is awake, and Windows bootstraps first so that it can install WSL. See [Install a Windows desktop](../docs/runbooks/install-a-windows-desktop.md).
- **Profiles**: `MISE_ENV=work` loads `mise.work.toml` identity overrides and activates `.config/git/config.work` via Git `[includeIf]`.
- **Skills**: source under `skills/`; deployed directly to `~/.agents/skills`, `~/.claude/skills`, and `~/.gemini/config/skills`.
- **pi package**: `pi/mate/` is a local pi package, loaded in place from `~/.dotfiles/pi/mate` (`mise run pi:setup` installs it, seeds `~/.pi/agent/settings.json` from `pi/settings.seed.json`, filling only missing keys, and removes links into `.pi/agent` and copies of this repo's files from pi's `extensions`, `prompts` and `themes`; it runs on Linux and macOS only). Its extensions put `persona.md` then `workstation.md` into pi's system prompt and register the weather, kthx and `.mcp.json` MCP servers; `mcp.ts` and `repo-skills.ts` find the repo root by the package's real path, so moving the package breaks them. `apps/mate` bakes `persona.md` and `.agents/AGENTS.md` into Rowbutt's system prompt, so an edit to either rebuilds the mate image, and `persona.md` must claim no capability; local-only facts go in `workstation.md`. `~/.pi/agent/agents` is still a link to `.pi/agent/agents`.

## Git workflow

Commits signed (SSH) with Conventional Commits. Do not commit directly to `main` — use PRs (`gh pr create`).
