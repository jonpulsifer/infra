#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
DOTFILES_DIR="$(cd "${SCRIPT_DIR}/.." && pwd)"

# --dry-run only checks that every source exists. CI runs it.
DRY_RUN=0
if [[ "${1:-}" == "--dry-run" ]]; then
  DRY_RUN=1
fi

PROBLEMS=0

if [[ "$DRY_RUN" == "1" ]]; then
  echo "Checking dotfiles links from ${DOTFILES_DIR}..."
else
  echo "Deploying dotfiles from ${DOTFILES_DIR}..."
fi

link_file() {
  local src="$1"
  local dst="$2"

  if [[ ! -e "$src" && ! -L "$src" ]]; then
    echo "Warning: Source $src does not exist, skipping." >&2
    PROBLEMS=$((PROBLEMS + 1))
    return 0
  fi

  if [[ "$DRY_RUN" == "1" ]]; then
    echo "Would link $dst -> $src"
    return 0
  fi

  mkdir -p "$(dirname "$dst")"
  ln -sfn "$src" "$dst"
  echo "Linked $dst -> $src"
}

link_file "${DOTFILES_DIR}" "${HOME}/.dotfiles"

link_file "${DOTFILES_DIR}/.tmux.conf" "${HOME}/.tmux.conf"
link_file "${DOTFILES_DIR}/.vimrc" "${HOME}/.vimrc"
link_file "${DOTFILES_DIR}/.config/.bunfig.toml" "${HOME}/.config/.bunfig.toml"
link_file "${DOTFILES_DIR}/.config/git" "${HOME}/.config/git"
link_file "${DOTFILES_DIR}/.config/ghostty/config" "${HOME}/.config/ghostty/config"
# home-manager generates these where HM_ACTIVATED=1, and a file it did not create
# fails its whole activation.
if [[ "${HM_ACTIVATED:-0}" != "1" ]]; then
  link_file "${DOTFILES_DIR}/.zshenv" "${HOME}/.zshenv"
  link_file "${DOTFILES_DIR}/.config/zsh" "${HOME}/.config/zsh"
  link_file "${DOTFILES_DIR}/.config/nvim" "${HOME}/.config/nvim"
fi
link_file "${DOTFILES_DIR}/.local/bin" "${HOME}/.local/bin"
link_file "${DOTFILES_DIR}/.ssh/config" "${HOME}/.ssh/config"
link_file "${DOTFILES_DIR}/.gnupg/gpg.conf" "${HOME}/.gnupg/gpg.conf"
link_file "${DOTFILES_DIR}/mise-global-config.toml" "${HOME}/.config/mise/config.toml"

link_file "${DOTFILES_DIR}/.agents/AGENTS.md" "${HOME}/.agents/AGENTS.md"
link_file "${DOTFILES_DIR}/.agents/AGENTS.md" "${HOME}/.claude/CLAUDE.md"
link_file "${DOTFILES_DIR}/.agents/AGENTS.md" "${HOME}/.codex/AGENTS.md"
link_file "${DOTFILES_DIR}/.agents/AGENTS.md" "${HOME}/.pi/agent/AGENTS.md"
link_file "${DOTFILES_DIR}/.agents/AGENTS.md" "${HOME}/.gemini/GEMINI.md"
link_file "${DOTFILES_DIR}/.agents/AGENTS.md" "${HOME}/.config/opencode/agents/global.md"

link_file "${DOTFILES_DIR}/skills" "${HOME}/.agents/skills"
link_file "${DOTFILES_DIR}/skills" "${HOME}/.claude/skills"
link_file "${DOTFILES_DIR}/skills" "${HOME}/.gemini/config/skills"

link_file "${DOTFILES_DIR}/.pi/agent/agents" "${HOME}/.pi/agent/agents"
link_file "${DOTFILES_DIR}/.pi/agent/extensions" "${HOME}/.pi/agent/extensions"
link_file "${DOTFILES_DIR}/.pi/agent/prompts" "${HOME}/.pi/agent/prompts"
link_file "${DOTFILES_DIR}/.pi/agent/themes" "${HOME}/.pi/agent/themes"
link_file "${DOTFILES_DIR}/.claude/settings.json" "${HOME}/.claude/settings.json"
link_file "${DOTFILES_DIR}/.claude/statusline.sh" "${HOME}/.claude/statusline.sh"

if [[ "$PROBLEMS" -gt 0 ]]; then
  echo "${PROBLEMS} missing source(s) -- see warnings above." >&2
  exit 1
fi

if [[ "$DRY_RUN" == "1" ]]; then
  echo "All dotfiles sources resolve."
else
  echo "Dotfiles successfully deployed!"
fi
