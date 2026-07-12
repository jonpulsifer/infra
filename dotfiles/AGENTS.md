# AGENTS.md

Guidance for AI coding agents working in this directory.

## Repository overview

mise-managed dotfiles (`[dotfiles]` + `mise bootstrap`): zsh (pure + plugins via the
`http:` backend, see `mise-global-config.toml`), tmux, vim, git, mise global tools, SSH,
GPG (Linux), Ghostty, and Claude Code / Gemini agent skill deployment.

## Development tools

- **mise**: global CLI versions + zsh plugin pins in `mise-global-config.toml` (deployed
  to `~/.config/mise/config.toml`); project tools via per-repo `mise.toml`; this
  directory's own `mise.toml` holds the `[dotfiles]` table, not a tool list.
- **Identity**: personal git identity is `[vars]` in `mise.toml`; work overrides
  (the replacement for `eq .chezmoi.username "jpulsifer"`) live in `mise.work.toml`,
  loaded via `MISE_ENV=work`.

## Build & validation

```bash
mise dotfiles apply --dry-run
shellcheck .local/bin/* 2>/dev/null
```

## Architecture

- **Templating**: real per-machine/OS/work-personal conditionals (Tera) live in
  `.config/git/config`, `.ssh/config`, `.gnupg/gpg.conf`, `.config/ghostty/config`,
  `.config/zsh/.zshrc`, `mise-global-config.toml`, `.claude/statusline.sh`. WSL detection
  has no native mise function — done via `exec()` against `/proc/sys/kernel/osrelease`.
  `.claude/settings.json` has no per-machine variance and is plain `mode = "copy"`
  (folds in what was a separately-named, never-actually-applied `settings.chezmoi.json`
  under chezmoi).
- **Skills**: source under `skills/`; `mise.toml` deploys the whole directory directly to
  `~/.agents/skills`, `~/.claude/skills`, and `~/.gemini/config/skills` (no per-file
  wrapper indirection).
- **Shell utils**: `.local/bin/*` on `PATH` (see `.config/zsh/.zshrc`).
- **Permissions**: `~/.ssh` and `~/.gnupg` need restrictive modes mise's `[dotfiles]` has
  no mechanism for — a `[bootstrap.hooks].post-dotfiles` hook in `mise.toml` chmods them.

## Git workflow

Commits signed (SSH) with Conventional Commits. Do not commit directly to `main` — use PRs
(`gh pr create`).

## Work/personal identity

Selected by `MISE_ENV`, not OS-username inference. `mise.toml`'s `[vars]` holds personal
defaults; `mise.work.toml` overrides `git_email`, `git_signingkey`, `moonpay_ssh_prefix`,
and `moonpay_instead_of` when `MISE_ENV=work` is active.
