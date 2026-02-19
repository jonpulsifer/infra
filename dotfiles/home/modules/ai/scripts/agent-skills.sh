#!/usr/bin/env bash
set -euo pipefail

CANONICAL_DIR="$HOME/.agents/skills"
SCAN_DIRS=(
  "$HOME/.agents/skills"
  "$HOME/.codex/skills"
  "$HOME/.cursor/skills-cursor"
)
TOOL_DIRS=(
  "$HOME/.cursor/skills"
  "$HOME/.claude/skills"
  "$HOME/.config/opencode/skills"
)
TOOL_NAMES=("cursor" "claude" "opencode")

BOLD='\033[1m'
DIM='\033[2m'
GREEN='\033[32m'
YELLOW='\033[33m'
CYAN='\033[36m'
RED='\033[31m'
RESET='\033[0m'

preview_cmd() {
  if command -v bat &>/dev/null; then
    echo "bat --style=plain --color=always --language=markdown {}/SKILL.md 2>/dev/null || cat {}/SKILL.md"
  else
    echo "cat {}/SKILL.md"
  fi
}

parse_description() {
  local skill_file="$1"
  sed -n '/^---$/,/^---$/{ /^description:/{ s/^description: *//; p; q; } }' "$skill_file" 2>/dev/null || echo ""
}

discover_skills() {
  local -A seen
  for dir in "${SCAN_DIRS[@]}"; do
    [ -d "$dir" ] || continue
    for skill_dir in "$dir"/*/; do
      [ -f "$skill_dir/SKILL.md" ] || continue
      local name
      name=$(basename "$skill_dir")
      [ "$name" = ".system" ] && continue
      if [ -z "${seen[$name]:-}" ]; then
        seen[$name]=1
        echo "${skill_dir%/}"
      fi
    done
  done
}

skill_status() {
  local name="$1"
  local status=""
  for i in "${!TOOL_DIRS[@]}"; do
    local tool_dir="${TOOL_DIRS[$i]}"
    local tool_name="${TOOL_NAMES[$i]}"
    if [ -e "$tool_dir/$name" ]; then
      status+="${GREEN}${tool_name}${RESET} "
    else
      status+="${DIM}${tool_name}${RESET} "
    fi
  done
  echo -e "$status"
}

sync_skill() {
  local name="$1"
  local source="$CANONICAL_DIR/$name"

  if [ ! -d "$source" ]; then
    echo -e "${RED}Skill '$name' not found in $CANONICAL_DIR${RESET}" >&2
    return 1
  fi

  for i in "${!TOOL_DIRS[@]}"; do
    local tool_dir="${TOOL_DIRS[$i]}"
    local tool_name="${TOOL_NAMES[$i]}"
    local target="$tool_dir/$name"

    mkdir -p "$tool_dir"

    if [ -L "$target" ]; then
      echo -e "  ${DIM}${tool_name}: already linked${RESET}"
    elif [ -d "$target" ]; then
      echo -e "  ${YELLOW}${tool_name}: exists (not a symlink, skipping)${RESET}"
    else
      ln -s "$source" "$target"
      echo -e "  ${GREEN}${tool_name}: linked${RESET}"
    fi
  done
}

cmd_list() {
  local skills
  skills=$(discover_skills)

  if [ -z "$skills" ]; then
    echo -e "${DIM}No skills found${RESET}"
    return
  fi

  printf "${BOLD}%-25s %-30s %s${RESET}\n" "SKILL" "TOOLS" "DESCRIPTION"
  printf "%s\n" "$(printf '%.0s─' {1..80})"

  while IFS= read -r skill_dir; do
    local name
    name=$(basename "$skill_dir")
    local desc
    desc=$(parse_description "$skill_dir/SKILL.md")
    local status
    status=$(skill_status "$name")
    printf "%-25s %-50b %s\n" "$name" "$status" "${desc:0:40}"
  done <<< "$skills"
}

cmd_sync() {
  if [ "${1:-}" = "--all" ]; then
    echo -e "${BOLD}Syncing all skills from $CANONICAL_DIR${RESET}"
    for skill_dir in "$CANONICAL_DIR"/*/; do
      [ -f "$skill_dir/SKILL.md" ] || continue
      local name
      name=$(basename "$skill_dir")
      echo -e "\n${CYAN}$name${RESET}"
      sync_skill "$name"
    done
  elif [ -n "${1:-}" ]; then
    echo -e "${BOLD}Syncing skill: ${CYAN}$1${RESET}"
    sync_skill "$1"
  else
    echo "Usage: agent-skills sync <name|--all>" >&2
    return 1
  fi
}

cmd_interactive() {
  local skills
  skills=$(discover_skills)

  if [ -z "$skills" ]; then
    echo -e "${DIM}No skills found${RESET}"
    return
  fi

  local entries=()
  while IFS= read -r skill_dir; do
    local name
    name=$(basename "$skill_dir")
    local desc
    desc=$(parse_description "$skill_dir/SKILL.md")
    entries+=("$skill_dir")
  done <<< "$skills"

  local selected
  selected=$(printf '%s\n' "${entries[@]}" | fzf \
    --header "agent-skills: select a skill to sync (tab to multi-select)" \
    --preview "$(preview_cmd)" \
    --preview-window "right:60%:wrap" \
    --multi \
    --with-nth=-1 \
    --delimiter='/' \
    --bind "ctrl-a:toggle-all" \
  ) || return 0

  while IFS= read -r skill_dir; do
    local name
    name=$(basename "$skill_dir")

    if [ ! -d "$CANONICAL_DIR/$name" ]; then
      echo -e "\n${CYAN}$name${RESET} ${DIM}(copying to canonical dir)${RESET}"
      cp -r "$skill_dir" "$CANONICAL_DIR/$name"
    else
      echo -e "\n${CYAN}$name${RESET}"
    fi

    sync_skill "$name"
  done <<< "$selected"
}

case "${1:-}" in
  list)   cmd_list ;;
  sync)   shift; cmd_sync "$@" ;;
  help|--help|-h)
    echo "Usage: agent-skills [command]"
    echo ""
    echo "Commands:"
    echo "  (none)       Interactive fzf skill browser"
    echo "  list         List all discovered skills and their status"
    echo "  sync <name>  Symlink a skill into all tool directories"
    echo "  sync --all   Symlink all canonical skills into all tools"
    echo "  help         Show this help"
    ;;
  *)      cmd_interactive ;;
esac
