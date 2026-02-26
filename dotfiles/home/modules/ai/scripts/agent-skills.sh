#!/usr/bin/env bash
set -euo pipefail

# Nix manages outbound skill distribution to ~/.agents/skills/, ~/.claude/skills/,
# and ~/.config/opencode/skills/. This script discovers non-Nix skills from
# external sources and backfills them into the canonical directory.

CANONICAL_DIR="$HOME/.agents/skills"
SCAN_DIRS=(
  "$HOME/.codex/skills"
  "$HOME/.cursor/skills-cursor"
)
BACKFILL_DIRS=(
  "$HOME/.claude/skills"
)

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

is_nix_managed() {
  local path="$1"
  [[ -L "$path" && "$(readlink "$path")" == /nix/store/* ]]
}

discover_external_skills() {
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

discover_all_skills() {
  local -A seen
  for dir in "$CANONICAL_DIR" "${SCAN_DIRS[@]}"; do
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

  if [ -e "$CANONICAL_DIR/$name" ]; then
    if is_nix_managed "$CANONICAL_DIR/$name/SKILL.md"; then
      status+="${GREEN}nix${RESET} "
    else
      status+="${YELLOW}local${RESET} "
    fi
  else
    status+="${DIM}missing${RESET} "
  fi

  for dir in "${BACKFILL_DIRS[@]}"; do
    local tool_name
    tool_name=$(basename "$(dirname "$dir")")
    if [ -e "$dir/$name" ]; then
      if is_nix_managed "$dir/$name/SKILL.md"; then
        status+="${GREEN}${tool_name}${RESET} "
      else
        status+="${CYAN}${tool_name}${RESET} "
      fi
    else
      status+="${DIM}${tool_name}${RESET} "
    fi
  done

  echo -e "$status"
}

backfill_skill() {
  local name="$1"
  local source="$2"

  if is_nix_managed "$CANONICAL_DIR/$name/SKILL.md" 2>/dev/null; then
    echo -e "  ${DIM}canonical: nix-managed, skipping${RESET}"
    return
  fi

  if [ ! -d "$CANONICAL_DIR/$name" ]; then
    mkdir -p "$CANONICAL_DIR"
    cp -r "$source" "$CANONICAL_DIR/$name"
    echo -e "  ${GREEN}canonical: imported${RESET}"
  else
    echo -e "  ${DIM}canonical: already exists${RESET}"
  fi

  for dir in "${BACKFILL_DIRS[@]}"; do
    local tool_name
    tool_name=$(basename "$(dirname "$dir")")
    local target="$dir/$name"

    if is_nix_managed "$target/SKILL.md" 2>/dev/null; then
      echo -e "  ${DIM}${tool_name}: nix-managed, skipping${RESET}"
    elif [ -L "$target" ]; then
      echo -e "  ${DIM}${tool_name}: already linked${RESET}"
    elif [ -d "$target" ]; then
      echo -e "  ${YELLOW}${tool_name}: exists (not a symlink, skipping)${RESET}"
    else
      mkdir -p "$dir"
      ln -s "$CANONICAL_DIR/$name" "$target"
      echo -e "  ${GREEN}${tool_name}: linked${RESET}"
    fi
  done
}

cmd_list() {
  local skills
  skills=$(discover_all_skills)

  if [ -z "$skills" ]; then
    echo -e "${DIM}No skills found${RESET}"
    return
  fi

  printf "${BOLD}%-25s %-30s %s${RESET}\n" "SKILL" "STATUS" "DESCRIPTION"
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
    echo -e "${BOLD}Backfilling non-Nix skills into $CANONICAL_DIR${RESET}"
    local skills
    skills=$(discover_external_skills)
    if [ -z "$skills" ]; then
      echo -e "${DIM}No external skills found to backfill${RESET}"
      return
    fi
    while IFS= read -r skill_dir; do
      local name
      name=$(basename "$skill_dir")
      echo -e "\n${CYAN}$name${RESET}"
      backfill_skill "$name" "$skill_dir"
    done <<< "$skills"
  elif [ -n "${1:-}" ]; then
    local name="$1"
    echo -e "${BOLD}Backfilling skill: ${CYAN}$name${RESET}"
    local source=""
    for dir in "${SCAN_DIRS[@]}"; do
      if [ -d "$dir/$name" ] && [ -f "$dir/$name/SKILL.md" ]; then
        source="$dir/$name"
        break
      fi
    done
    if [ -z "$source" ] && [ -d "$CANONICAL_DIR/$name" ]; then
      source="$CANONICAL_DIR/$name"
    fi
    if [ -z "$source" ]; then
      echo -e "${RED}Skill '$name' not found in scan directories${RESET}" >&2
      return 1
    fi
    backfill_skill "$name" "$source"
  else
    echo "Usage: agent-skills sync <name|--all>" >&2
    return 1
  fi
}

cmd_interactive() {
  local skills
  skills=$(discover_external_skills)

  if [ -z "$skills" ]; then
    echo -e "${DIM}No external skills found to backfill${RESET}"
    return
  fi

  local selected
  selected=$(printf '%s\n' "$skills" | fzf \
    --header "agent-skills: select skills to backfill (tab to multi-select)" \
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
    echo -e "\n${CYAN}$name${RESET}"
    backfill_skill "$name" "$skill_dir"
  done <<< "$selected"
}

case "${1:-}" in
  list)   cmd_list ;;
  sync)   shift; cmd_sync "$@" ;;
  help|--help|-h)
    echo "Usage: agent-skills [command]"
    echo ""
    echo "Commands:"
    echo "  (none)       Interactive fzf browser for external skills"
    echo "  list         List all skills and their status (nix/local/missing)"
    echo "  sync <name>  Backfill a skill into canonical + Claude directories"
    echo "  sync --all   Backfill all external skills"
    echo "  help         Show this help"
    ;;
  *)      cmd_interactive ;;
esac
