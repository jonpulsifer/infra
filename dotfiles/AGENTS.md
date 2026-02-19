# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Repository Overview

Nix flake-based home-manager dotfiles supporting multiple machine configurations (Linux x86_64/ARM, macOS aarch64). Not NixOS system configs — home-manager only.

## Build & Validation

```bash
# Enter dev shell (provides nixfmt-tree + shellcheck)
nix develop

# Format all Nix files
nix fmt

# Check flake validity
nix flake check

# Build a specific config
nix build .#<name>   # names: default, basic, arm, homebook, work

# Apply to current machine (macOS)
./result/sw/bin/darwin-rebuild switch --flake .

# Apply to current machine (Linux)
nix run
```

Linting: `nixfmt-tree` for Nix, `shellcheck` for shell scripts. Both available in `nix develop`.

## Architecture

### Flake Outputs (`flake.nix`)

Five home configurations built via `mkHome system modules`:

| Name       | System           | Entry Point                          |
|------------|------------------|--------------------------------------|
| `full`     | x86_64-linux     | `home/home.nix`                      |
| `basic`    | x86_64-linux     | `home/basic.nix`                     |
| `arm`      | aarch64-linux    | `home/basic.nix`                     |
| `homebook` | aarch64-darwin   | `home/home.nix` + `home/darwin.nix`  |
| `work`     | aarch64-darwin   | `home/work.nix`                      |

Overlays applied globally: `llm-agents.nix`, `gh-aipr`, custom `shell-utils`.

### Module Hierarchy

`home/basic.nix` — base config imported by everything: git, nix, tmux, zsh, vim + core packages.

`home/home.nix` — full dev stack: imports `basic.nix` + gcloud, go, javascript, kubernetes, ai, ssh, terraform modules.

`home/darwin.nix` — macOS additions: Ghostty terminal, font config, `copyApps = true`.

`home/work.nix` — work profile: extends `home.nix` with 1Password SSH, Homebrew path prefix.

All modules live in `home/modules/`. Each module is self-contained and manages its own packages, programs, and config files.

### AI Agent Integration (`home/modules/ai/default.nix`)

**MCP servers** are defined once in `mcpServers` and fanned out to all agents:
- Cursor → `.cursor/mcp.json`
- Claude Code → `~/.claude.json` (merged via activation script, preserves runtime state)
- OpenCode → `~/.config/opencode/opencode.json`
- Gemini → `~/.config/gemini/settings.json`

**Skills system** uses the [agentskills.io](https://agentskills.io) `SKILL.md` format:
- Canonical source: `~/.agents/skills/<name>/SKILL.md`
- Symlinked into: `.claude/skills/`, `.cursor/skills/`, `~/.config/opencode/skills/`
- Skill definitions live in `home/modules/ai/skills/` (read via `builtins.readFile`)
- `personal-context` skill is generated inline from the `context` attrset in `default.nix`

To add a new skill: create `home/modules/ai/skills/<name>.md`, add it to the `skills` attrset in `default.nix`.

### Custom Packages (`pkgs/`)

`pkgs/shell-utils.nix` — bundles shell scripts from `pkgs/shell-utils/` (np, nr, ns, tm, sssh, etc.) into a single derivation exposed as `pkgs.shell-utils`.

## Git Workflow

Commits must be signed (SSH), use Conventional Commits format, and include DCO sign-off (`-s` flag). `format.signoff = true` adds sign-off automatically.

**Never commit directly to `main`**. Always open PRs via `gh pr create`. Check CI status after opening.

Useful aliases: `git lol` (graph log), `git lg` (compact log), `git undo` (soft reset HEAD~1), `git save` (savepoint commit).

## Code Style

- Nix: `nixfmt-tree` (run via `nix fmt`)
- Shell: `shellcheck` clean, no bashisms unless targeting bash explicitly
- Prefer `lib.mkDefault` for overridable values in modules
- Use `lib.optionals isDarwin`/`isLinux` for platform-conditional packages
- MCP server definitions go in `home/modules/ai/default.nix` only — single source of truth
