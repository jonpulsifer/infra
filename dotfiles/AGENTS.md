# AGENTS.md

Guidance for AI coding agents working in this directory.

## Repository overview

mise-managed dotfiles (`mise bootstrap`): zsh (pure + plugins — home-manager on NixOS, `http:` backend on macOS, see `mise-global-config.toml`),
tmux, vim, git, Homebrew / Nix (home-manager) / Mise tooling, SSH, GPG, Ghostty, and agent skill deployment.

## Development tools

- **Homebrew (macOS)**: Core shell tools (`eza`, `fzf`, `neovim`, `bat`, `ripgrep`, `fd`, `git-delta`, `jq`, `gh`, `btop`, `sd`), Casks & fonts, plus zsh plugins via the mise `http:` backend.
- **Nix (Linux/NixOS)**: OS system state, system closure, and home-manager-managed shell tooling + zsh plugins for the `jawn` user (`nix/home/jawn.nix`).
- **Mise**: Polyglot runtimes (`bun`, `node`), K8s/Cloud tools (`kubectl`, `helm`, `k9s`), AI agents, macOS zsh plugins, task orchestration (`mise bootstrap`), and profile switching (`MISE_ENV=work`).

## Build & validation

```bash
mise run check
shellcheck .local/bin/* 2>/dev/null
```

## Architecture

- **Bootstrap**: `mise bootstrap` auto-detects OS (`uname -s`) and routes to `bootstrap:macos` or `bootstrap:linux`, running `scripts/deploy-dotfiles.sh` for atomic symlinking.
- **Profiles**: `MISE_ENV=work` loads `mise.work.toml` identity overrides and activates `.config/git/config.work` via Git `[includeIf]`.
- **Skills**: source under `skills/`; deployed directly to `~/.agents/skills`, `~/.claude/skills`, and `~/.gemini/config/skills`.

## Git workflow

Commits signed (SSH) with Conventional Commits. Do not commit directly to `main` — use PRs (`gh pr create`).
