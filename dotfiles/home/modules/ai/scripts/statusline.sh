#!/usr/bin/env bash
# Claude Code status line
# Receives JSON on stdin; outputs a two-line status bar.

input=$(cat)

# -- Extract fields -----------------------------------------------------------
model=$(echo "$input"   | jq -r '.model.display_name // .model.id // "Claude"')
cwd=$(echo "$input"     | jq -r '.workspace.current_dir // .cwd // "?"')
dir_name=$(basename "$cwd")

used_pct=$(echo "$input"    | jq -r '.context_window.used_percentage      // empty')
remaining_pct=$(echo "$input" | jq -r '.context_window.remaining_percentage // empty')
total_in=$(echo "$input"    | jq -r '.context_window.total_input_tokens    // empty')
total_out=$(echo "$input"   | jq -r '.context_window.total_output_tokens   // empty')

# -- Git info (run from CWD) --------------------------------------------------
# Use --no-optional-locks to avoid index.lock conflicts with concurrent git operations
GIT="git --no-optional-locks -C $cwd"
GIT_BRANCH=""
GIT_STATUS=""
if $GIT rev-parse --is-inside-work-tree &>/dev/null; then
  GIT_BRANCH=$($GIT symbolic-ref --short HEAD 2>/dev/null || $GIT rev-parse --short HEAD 2>/dev/null || echo "")

  # Dirty state (unstaged + staged + untracked)
  DIRTY=""
  if [ -n "$($GIT status --porcelain 2>/dev/null)" ]; then
    DIRTY="*"
  fi

  # Ahead/behind remote
  AHEAD_BEHIND=""
  UPSTREAM=$($GIT rev-parse --abbrev-ref '@{upstream}' 2>/dev/null || echo "")
  if [ -n "$UPSTREAM" ]; then
    AHEAD=$($GIT rev-list --count '@{upstream}..HEAD' 2>/dev/null || echo "0")
    BEHIND=$($GIT rev-list --count 'HEAD..@{upstream}' 2>/dev/null || echo "0")
    [ "$AHEAD" -gt 0 ] 2>/dev/null && AHEAD_BEHIND+="↑${AHEAD}"
    [ "$BEHIND" -gt 0 ] 2>/dev/null && AHEAD_BEHIND+="↓${BEHIND}"
  fi

  GIT_STATUS="${GIT_BRANCH}${DIRTY}"
  [ -n "$AHEAD_BEHIND" ] && GIT_STATUS+=" ${AHEAD_BEHIND}"
fi

# -- ANSI palette -------------------------------------------------------------
RESET='\033[0m'
BOLD='\033[1m'
DIM='\033[2m'
CYAN='\033[36m'
YELLOW='\033[33m'
GREEN='\033[32m'
MAGENTA='\033[35m'
BLUE='\033[34m'
RED='\033[31m'

# -- Context usage ------------------------------------------------------------
ctx_seg=""
if [ -n "$used_pct" ]; then
  used_int=$(printf "%.0f" "$used_pct")
  if awk "BEGIN{exit !($used_pct > 80)}"; then
    ctx_color="$RED"
  elif awk "BEGIN{exit !($used_pct > 50)}"; then
    ctx_color="$YELLOW"
  else
    ctx_color="$GREEN"
  fi
  ctx_seg="${DIM}ctx:${RESET}${ctx_color}${used_int}%${RESET}"
fi

# -- Token totals -------------------------------------------------------------
tok_seg=""
if [ -n "$total_in" ] && [ -n "$total_out" ]; then
  total=$(( total_in + total_out ))
  if [ "$total" -ge 1000 ]; then
    total_fmt=$(awk "BEGIN{printf \"%.1fk\", $total/1000}")
  else
    total_fmt="$total"
  fi
  tok_seg="${DIM}tok:${RESET}${DIM}${total_fmt}${RESET}"
fi

# -- Assemble lines -----------------------------------------------------------
# Line 1: model  dirname  [ctx]  [tokens]
line1="${CYAN}${BOLD}${model}${RESET}  ${MAGENTA}${BOLD}${dir_name}${RESET}"
[ -n "$GIT_BRANCH" ] && line1="${line1}  ${MAGENTA}⎇ ${GIT_STATUS}${RESET}"
[ -n "$ctx_seg" ]  && line1="${line1}  ${ctx_seg}"
[ -n "$tok_seg" ]  && line1="${line1}  ${tok_seg}"

# Line 2: full path (dimmed)
line2="${DIM}${BLUE}${cwd}${RESET}"

printf '%b\n%b\n' "$line1" "$line2"
