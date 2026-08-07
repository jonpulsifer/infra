#!/usr/bin/env bash
set -euo pipefail

# Script location determines the dotfiles directory root
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
DOTFILES_DIR="$(cd "${SCRIPT_DIR}/.." && pwd)"

echo "Deploying dotfiles from ${DOTFILES_DIR}..."

# Helper function to create parent directories and atomic symlinks
link_file() {
  local src="$1"
  local dst="$2"

  if [[ ! -e "$src" && ! -L "$src" ]]; then
    echo "Warning: Source $src does not exist, skipping." >&2
    return 0
  fi

  mkdir -p "$(dirname "$dst")"
  ln -sfn "$src" "$dst"
  echo "Linked $dst -> $src"
}

# 1. Base dotfiles pointer
link_file "${DOTFILES_DIR}" "${HOME}/.dotfiles"

# 2. Individual config files and directories
link_file "${DOTFILES_DIR}/.tmux.conf" "${HOME}/.tmux.conf"
link_file "${DOTFILES_DIR}/.vimrc" "${HOME}/.vimrc"
link_file "${DOTFILES_DIR}/.zshenv" "${HOME}/.zshenv"
link_file "${DOTFILES_DIR}/.config/.bunfig.toml" "${HOME}/.config/.bunfig.toml"
link_file "${DOTFILES_DIR}/.config/git" "${HOME}/.config/git"
link_file "${DOTFILES_DIR}/.config/ghostty/config" "${HOME}/.config/ghostty/config"
link_file "${DOTFILES_DIR}/.config/nvim" "${HOME}/.config/nvim"
# On NixOS hosts where home-manager owns zsh (HM_ACTIVATED=1), skip deploying
# the .config/zsh dir: home-manager writes ~/.config/zsh/.zshrc itself, and a
# symlink here would shadow its generated file. Everything else (.zshenv,
# git, ssh, ...) still deploys.
if [[ "${HM_ACTIVATED:-0}" != "1" ]]; then
  link_file "${DOTFILES_DIR}/.config/zsh" "${HOME}/.config/zsh"
fi
link_file "${DOTFILES_DIR}/.local/bin" "${HOME}/.local/bin"
link_file "${DOTFILES_DIR}/.ssh/config" "${HOME}/.ssh/config"
link_file "${DOTFILES_DIR}/.gnupg/gpg.conf" "${HOME}/.gnupg/gpg.conf"
link_file "${DOTFILES_DIR}/mise-global-config.toml" "${HOME}/.config/mise/config.toml"

# 3. Agent instructions and settings
link_file "${DOTFILES_DIR}/.agents/AGENTS.md" "${HOME}/.agents/AGENTS.md"
link_file "${DOTFILES_DIR}/.agents/AGENTS.md" "${HOME}/.claude/CLAUDE.md"
link_file "${DOTFILES_DIR}/.agents/AGENTS.md" "${HOME}/.codex/AGENTS.md"
link_file "${DOTFILES_DIR}/.agents/AGENTS.md" "${HOME}/.pi/agent/AGENTS.md"
link_file "${DOTFILES_DIR}/.agents/AGENTS.md" "${HOME}/.gemini/GEMINI.md"
link_file "${DOTFILES_DIR}/.agents/AGENTS.md" "${HOME}/.config/opencode/agents/global.md"

# 4. Agent skills
link_file "${DOTFILES_DIR}/skills" "${HOME}/.agents/skills"
link_file "${DOTFILES_DIR}/skills" "${HOME}/.claude/skills"
link_file "${DOTFILES_DIR}/skills" "${HOME}/.gemini/config/skills"

# 5. Agent prompts, extensions, settings, statusline
link_file "${DOTFILES_DIR}/.pi/agent/agents" "${HOME}/.pi/agent/agents"
link_file "${DOTFILES_DIR}/.pi/agent/extensions" "${HOME}/.pi/agent/extensions"
link_file "${DOTFILES_DIR}/.pi/agent/prompts" "${HOME}/.pi/agent/prompts"
link_file "${DOTFILES_DIR}/.pi/agent/themes" "${HOME}/.pi/agent/themes"
link_file "${DOTFILES_DIR}/.claude/settings.json" "${HOME}/.claude/settings.json"
link_file "${DOTFILES_DIR}/.claude/statusline.sh" "${HOME}/.claude/statusline.sh"

echo "Dotfiles successfully deployed!"
