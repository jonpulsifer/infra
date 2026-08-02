#!/usr/bin/env bash
# shellcheck disable=SC2154
# Claude Code status line — receives JSON on stdin; outputs a three-line status bar.
# Line 1: repo · branch · changed files · +additions/-deletions
# Line 2: model · agent · rank+cost · tokens · context meter · duration · fuse
# Line 3: 5-hour and 7-day plan quotas (omitted when the plan has no rate limits).
#         Quota meters carry a ╎ pace marker at "% of the window elapsed": fill left
#         of it means burning under budget, right of it means the quota runs out
#         before it resets.
# Requires a Nerd Font for glyph rendering.

input=$(cat)

# -- Batched field extraction (single jq call) --------------------------------
eval "$(echo "$input" | jq -r '
  @sh "model=\(.model.display_name // .model.id // "Claude")",
  @sh "cwd=\(.workspace.current_dir // .cwd // "?")",
  @sh "used_pct=\(.context_window.used_percentage // "")",
  @sh "total_in=\(.context_window.total_input_tokens // "")",
  @sh "total_out=\(.context_window.total_output_tokens // "")",
  @sh "ctx_in=\(.context_window.current_usage.input_tokens // "")",
  @sh "ctx_cache_read=\(.context_window.current_usage.cache_read_input_tokens // "")",
  @sh "ctx_cache_create=\(.context_window.current_usage.cache_creation_input_tokens // "")",
  @sh "ctx_out=\(.context_window.current_usage.output_tokens // "")",
  @sh "ctx_size=\(.context_window.context_window_size // "")",
  @sh "cost_usd=\(.cost.total_cost_usd // "")",
  @sh "duration_ms=\(.cost.total_duration_ms // "")",
  @sh "lines_add=\(.cost.total_lines_added // "")",
  @sh "lines_rm=\(.cost.total_lines_removed // "")",
  @sh "agent_name=\(.agent.name // "")",
  @sh "effort=\(.effort.level // "")",
  @sh "rl_5h_pct=\(.rate_limits.five_hour.used_percentage // "")",
  @sh "rl_5h_reset=\(.rate_limits.five_hour.resets_at // "")",
  @sh "rl_7d_pct=\(.rate_limits.seven_day.used_percentage // "")",
  @sh "rl_7d_reset=\(.rate_limits.seven_day.resets_at // "")"
')"

dir_name=$(basename "$cwd")
NOW=$(date +%s)
QUOTA_W=14

# -- 256-color ANSI palette ----------------------------------------------------
RST='\033[0m'
B='\033[1m'
c() { printf '\033[38;5;%dm' "$1"; }
C_PURPLE=$(c 141)
C_PINK=$(c 204)
C_ORANGE=$(c 208)
C_GOLD=$(c 220)
C_SKY=$(c 75)
C_MINT=$(c 114)
C_CORAL=$(c 203)
C_TEAL=$(c 73)
C_LAVEN=$(c 183)
C_GRAY=$(c 245)
C_DGRAY=$(c 239)
C_RED=$(c 196)
C_GREEN=$(c 82)
C_CYAN=$(c 51)

# -- Nerd Font glyphs (raw UTF-8 for bash 3.2 compat) -------------------------
G_BRANCH=$'\xEE\x9C\xA5'       # U+E725 nf-dev-git_branch
G_FOLDER=$'\xEF\x81\xBC'       # U+F07C nf-fa-folder_open
G_DOLLAR=$'\xEF\x85\x95'       # U+F155 nf-fa-dollar
G_CLOCK=$'\xEF\x80\x97'        # U+F017 nf-fa-clock_o
G_CODE=$'\xEF\x84\xA1'         # U+F121 nf-fa-code
G_COG=$'\xEF\x82\x85'          # U+F085 nf-fa-cogs
G_PLUS=$'\xEF\x91\x97'         # U+F457 nf-oct-diff_added
G_MINUS=$'\xEF\x91\x98'        # U+F458 nf-oct-diff_removed
G_AGENT=$'\xEF\x91\xAA'        # U+F46A nf-oct-hubot
G_FILE=$'\xEF\x80\x96'         # U+F016 nf-fa-file_o
G_HOURGLASS=$'\xEF\x89\x92'    # U+F252 nf-fa-hourglass_half
G_CALENDAR=$'\xEF\x81\xB3'     # U+F073 nf-fa-calendar
G_GAUGE=$'\xEF\x83\xA4'        # U+F0E4 nf-fa-tachometer
{%- set is_work = get_env(name="MISE_ENV", default="personal") == "work" %}
{% if is_work -%}
G_WALLET='🌕'                 # Full moon for MoonPay
{% endif -%}

# -- Helper: human-readable token counts --------------------------------------
fmt_tok() {
  local n=$1
  if [ -z "$n" ] || [ "$n" = "null" ]; then echo "0"; return; fi
  if [ "$n" -ge 1000000 ]; then
    awk "BEGIN{printf \"%.1fM\", $n/1000000}"
  elif [ "$n" -ge 1000 ]; then
    awk "BEGIN{printf \"%.1fk\", $n/1000}"
  else
    echo "$n"
  fi
}

# -- Helper: meter with sub-cell fill and an optional pace marker --------------
# Fills in eighths of a cell, so the bar moves on every update instead of
# jumping a whole block per 1/width. $1 percent (float ok)  $2 width
# $3 marker cell index (-1 = none). Colored by the caller's $bar_color.
EIGHTHS=("" "▏" "▎" "▍" "▌" "▋" "▊" "▉")
mkbar() {
  local pct=$1 w=$2 mark=$3 eighths full rem i bar=""
  eighths=$(awk -v p="$pct" -v w="$w" \
    'BEGIN{v=int(p*w*8/100+0.5); if(v<0)v=0; if(v>w*8)v=w*8; print v}')
  full=$(( eighths / 8 ))
  rem=$(( eighths % 8 ))
  local cell
  for (( i = 0; i < w; i++ )); do
    if [ "$i" -lt "$full" ]; then
      cell="█"
    elif [ "$i" = "$full" ] && [ "$rem" -gt 0 ]; then
      cell="${EIGHTHS[$rem]}"
    else
      cell="░"
    fi
    # The pace marker recolors its cell rather than replacing it, so it never
    # hides the fill underneath — including the partial cell at the leading edge.
    if [ "$i" = "$mark" ]; then
      bar+="${C_SKY}${cell}${RST}${bar_color}"
    else
      bar+="$cell"
    fi
  done
  printf '%s' "$bar"
}

# -- Helper: compact countdown (3d4h / 2h13m / 47m) ---------------------------
fmt_left() {
  local s=$1
  [ "$s" -le 0 ] && { echo "now"; return; }
  if [ "$s" -ge 86400 ]; then
    echo "$(( s / 86400 ))d$(( s % 86400 / 3600 ))h"
  elif [ "$s" -ge 3600 ]; then
    echo "$(( s / 3600 ))h$(( s % 3600 / 60 ))m"
  else
    echo "$(( s / 60 ))m"
  fi
}

# -- Helper: quota segment — bar with burn-pace marker, pct, reset countdown ---
# $1 glyph  $2 used_percentage  $3 resets_at (epoch)  $4 window seconds
quota_seg() {
  local glyph=$1 pct_raw=$2 reset=$3 window=$4
  [ -z "$pct_raw" ] || [ "$pct_raw" = "null" ] && return 0

  local pct left elapsed pace mark
  pct=$(printf '%.0f' "$pct_raw")
  left=$(( ${reset:-0} - NOW ))
  [ "$left" -lt 0 ] && left=0

  # Linear-pace marker: how far through the window we are. Burn left of it =
  # ahead of budget, right of it = on track to run out before the reset.
  elapsed=$(( window - left ))
  [ "$elapsed" -lt 0 ] && elapsed=0
  pace=$(( elapsed * 100 / window ))
  mark=$(( pace * QUOTA_W / 100 ))
  [ "$mark" -ge "$QUOTA_W" ] && mark=$(( QUOTA_W - 1 ))

  if [ "$pct" -ge 90 ]; then bar_color="$C_RED"
  elif [ "$pct" -gt $(( pace + 15 )) ]; then bar_color="$C_ORANGE"
  elif [ "$pct" -gt "$pace" ]; then bar_color="$C_GOLD"
  else bar_color="$C_MINT"; fi

  printf '%s%s %s %s%d%%%s %s%s%s' \
    "$bar_color" "$glyph" "$(mkbar "$pct_raw" "$QUOTA_W" "$mark")" \
    "$B" "$pct" "$RST" \
    "$C_DGRAY" "$(fmt_left "$left")" "$RST"
}

{% if is_work -%}
# -- MoonPay wallet balance (cached, non-blocking) ----------------------------
MP_CACHE="${TMPDIR:-/tmp}/claude-statusline-mp-balance"
MP_CACHE_LOCK="${MP_CACHE}.lock"
MP_CACHE_FORCE="${MP_CACHE}.force"
MP_CACHE_TTL=60

# Force refresh: touch /tmp/claude-statusline-mp-balance.force (or set MP_FORCE_REFRESH=1)
if [ -n "${MP_FORCE_REFRESH:-}" ] || [ -f "$MP_CACHE_FORCE" ]; then
  rm -f "$MP_CACHE" "$MP_CACHE_FORCE"
fi

_refresh_wallet_cache() {
  # Prevent concurrent refreshes
  if [ -f "$MP_CACHE_LOCK" ]; then
    local lock_mtime
    if stat -f %m "$MP_CACHE_LOCK" >/dev/null 2>&1; then
      lock_mtime=$(stat -f %m "$MP_CACHE_LOCK")
    else
      lock_mtime=$(stat -c %Y "$MP_CACHE_LOCK" 2>/dev/null || echo 0)
    fi
    local lock_age=$(( $(date +%s) - lock_mtime ))
    [ "$lock_age" -lt 60 ] && return 0
  fi

  echo $$ > "$MP_CACHE_LOCK" 2>/dev/null || return 1
  trap 'rm -f "$MP_CACHE_LOCK"' EXIT

  local wallets wallet_name balances
  wallets=$(mp wallet list --json 2>/dev/null) || { rm -f "$MP_CACHE_LOCK"; return 1; }
  wallet_name=$(echo "$wallets" | jq -r '.[0].name // empty' 2>/dev/null)
  [ -z "$wallet_name" ] && { rm -f "$MP_CACHE_LOCK"; return 1; }

  # Cache format: one line per token — symbol:amount:usd_value
  local tmp="${MP_CACHE}.tmp.$$"
  local all_items="[]"
  local chain_data
  for chain in solana ethereum; do
    chain_data=$(mp token balance list --wallet "$wallet_name" --chain "$chain" --json 2>/dev/null) || continue
    all_items=$(printf '%s\n%s' "$all_items" "$chain_data" | jq -s '.[0] + ([.[1].items[]?] // [])' 2>/dev/null)
  done

  echo "$all_items" | jq -r '
    [.[]? | select(.balance.value > 0)]
    | group_by(.symbol)
    | .[]
    | {symbol: .[0].symbol, amount: (map(.balance.amount // 0) | add), value: (map(.balance.value // 0) | add)}
    | "\(.symbol):\(.amount):\(.value)"
  ' > "$tmp" 2>/dev/null

  # If no tokens have balances, write a sentinel so we don't re-query constantly
  [ ! -s "$tmp" ] && echo "EMPTY" > "$tmp"

  mv "$tmp" "$MP_CACHE"
  rm -f "$MP_CACHE_LOCK"
  trap - EXIT
}

get_wallet_balance() {
  command -v mp >/dev/null 2>&1 || return 1

  local now
  now=$(date +%s)

  if [ -f "$MP_CACHE" ]; then
    local mtime
    if stat -f %m "$MP_CACHE" >/dev/null 2>&1; then
      mtime=$(stat -f %m "$MP_CACHE")
    else
      mtime=$(stat -c %Y "$MP_CACHE" 2>/dev/null || echo 0)
    fi
    local age=$(( now - mtime ))
    cat "$MP_CACHE"
    if [ "$age" -ge "$MP_CACHE_TTL" ]; then
      _refresh_wallet_cache &
      disown 2>/dev/null
    fi
    return 0
  fi

  _refresh_wallet_cache &
  disown 2>/dev/null
  return 1
}

{% endif -%}
# -- Git info ------------------------------------------------------------------
GIT="git --no-optional-locks -C $cwd"
GIT_BRANCH="" GIT_REMOTE_URL="" GIT_CHANGED=0
if $GIT rev-parse --is-inside-work-tree &>/dev/null; then
  GIT_BRANCH=$($GIT symbolic-ref --short HEAD 2>/dev/null \
    || $GIT rev-parse --short HEAD 2>/dev/null || echo "")

  porcelain=$($GIT status --porcelain 2>/dev/null)
  DIRTY=""
  if [ -n "$porcelain" ]; then
    DIRTY="*"
    GIT_CHANGED=$(echo "$porcelain" | wc -l | tr -d ' ')
  fi

  AHEAD_BEHIND=""
  UPSTREAM=$($GIT rev-parse --abbrev-ref '@{upstream}' 2>/dev/null || echo "")
  if [ -n "$UPSTREAM" ]; then
    AHEAD=$($GIT rev-list --count '@{upstream}..HEAD' 2>/dev/null || echo "0")
    BEHIND=$($GIT rev-list --count 'HEAD..@{upstream}' 2>/dev/null || echo "0")
    [ "$AHEAD" -gt 0 ] 2>/dev/null && AHEAD_BEHIND+="↑${AHEAD}"
    [ "$BEHIND" -gt 0 ] 2>/dev/null && AHEAD_BEHIND+="↓${BEHIND}"
  fi

  GIT_REMOTE_URL=$($GIT remote get-url origin 2>/dev/null \
    | sed 's|git@github\.com:|https://github.com/|' \
    | sed 's|\.git$||')
fi

# -- Line 1 segments ----------------------------------------------------------

# Repo: clickable OSC 8 link if we have a remote
repo_seg=""
if [ -n "$GIT_REMOTE_URL" ]; then
  repo_name=$(basename "$GIT_REMOTE_URL")
  repo_seg="${C_PINK}${B}${G_FOLDER} \033]8;;${GIT_REMOTE_URL}\a${repo_name}\033]8;;\a${RST}"
else
  repo_seg="${C_PINK}${B}${G_FOLDER} ${dir_name}${RST}"
fi

# Branch + dirty + ahead/behind
branch_seg=""
if [ -n "$GIT_BRANCH" ]; then
  branch_seg="${C_CYAN}${G_BRANCH} ${GIT_BRANCH}${DIRTY}${RST}"
  [ -n "$AHEAD_BEHIND" ] && branch_seg+=" ${C_ORANGE}${AHEAD_BEHIND}${RST}"
fi

# Changed file count
changed_seg=""
if [ "$GIT_CHANGED" -gt 0 ]; then
  changed_seg="${C_GOLD}${G_FILE} ${GIT_CHANGED}${RST}"
fi

# Lines added/removed (from Claude session)
lines_seg=""
if [ -n "$lines_add" ] && [ "$lines_add" != "null" ] && [ -n "$lines_rm" ] && [ "$lines_rm" != "null" ]; then
  if [ "$lines_add" -gt 0 ] || [ "$lines_rm" -gt 0 ]; then
    lines_seg="${C_GREEN}${G_PLUS}${lines_add}${RST} ${C_CORAL}${G_MINUS}${lines_rm}${RST}"
  fi
fi

{% if is_work -%}
# Wallet balance (MoonPay MPC — Solana)
wallet_seg=""
if wallet_data=$(get_wallet_balance 2>/dev/null); then
  if [ -n "$wallet_data" ] && [ "$wallet_data" != "EMPTY" ]; then
    tokens=""
    while IFS=: read -r sym amt val; do
      [ -z "$sym" ] && continue
      amt_fmt=$(awk "BEGIN{v=$amt; if(v>=1) printf \"%.2f\",v; else if(v>=0.001) printf \"%.4f\",v; else printf \"%.6f\",v}")
      val_fmt=$(awk "BEGIN{printf \"%.2f\", $val}")
      [ -n "$tokens" ] && tokens+=" ${C_DGRAY}|${RST} "
      tokens+="${C_MINT}${B}${sym}${RST}${C_GRAY}: ${amt_fmt} ${C_GOLD}(\$${val_fmt})${RST}"
    done <<< "$wallet_data"
    [ -n "$tokens" ] && wallet_seg="${C_LAVEN}${G_WALLET}${RST} ${tokens}"
  else
    wallet_seg="${C_LAVEN}${G_WALLET}${RST} ${C_GOLD}\$0.00${RST} ${C_GRAY}— fund me! 💸💰${RST}"
  fi
fi
{% endif -%}

# Plan quotas: 5-hour session window and 7-day weekly window
quota_5h_seg=$(quota_seg "$G_HOURGLASS" "$rl_5h_pct" "$rl_5h_reset" 18000)
quota_7d_seg=$(quota_seg "$G_CALENDAR" "$rl_7d_pct" "$rl_7d_reset" 604800)

# -- Line 2 segments ----------------------------------------------------------

# Model + reasoning effort (absent on models that don't take an effort level)
model_seg="${C_PURPLE}${B}${G_COG} ${model}${RST}"
case "$effort" in
  low)    model_seg+=" ${C_GRAY}${G_GAUGE} low${RST}" ;;
  medium) model_seg+=" ${C_SKY}${G_GAUGE} med${RST}" ;;
  high)   model_seg+=" ${C_GOLD}${G_GAUGE} high${RST}" ;;
  xhigh)  model_seg+=" ${C_ORANGE}${B}${G_GAUGE} xhigh${RST}" ;;
  max)    model_seg+=" ${C_RED}${B}${G_GAUGE} max${RST}" ;;
esac

# Agent
agent_seg=""
[ -n "$agent_name" ] && agent_seg="${C_LAVEN}${G_AGENT} ${agent_name}${RST}"

# Cost
cost_seg=""
if [ -n "$cost_usd" ] && [ "$cost_usd" != "null" ]; then
  cost_fmt=$(printf '%.2f' "$cost_usd")
  cost_seg="${C_GOLD}${B}${G_DOLLAR}${cost_fmt}${RST}"
fi

# Token totals
tok_seg=""
if [ -n "$total_in" ] && [ "$total_in" != "null" ]; then
  total_out_safe=${total_out:-0}
  [ "$total_out_safe" = "null" ] && total_out_safe=0
  grand_total=$(( total_in + total_out_safe ))
  grand_fmt=$(fmt_tok "$grand_total")
  in_fmt=$(fmt_tok "$total_in")
  out_fmt=$(fmt_tok "$total_out_safe")
  tok_seg="${C_TEAL}${G_CODE} ${B}${grand_fmt}${RST} ${C_GRAY}(${C_MINT}${in_fmt}↓${RST} ${C_CORAL}${out_fmt}↑${RST}${C_GRAY})${RST}"
fi

# Context bar
ctx_seg=""
if [ -n "$used_pct" ] && [ "$used_pct" != "null" ]; then
  pct_int=$(printf "%.0f" "$used_pct")
  if [ "$pct_int" -ge 90 ]; then bar_color="$C_RED"
  elif [ "$pct_int" -ge 70 ]; then bar_color="$C_ORANGE"
  elif [ "$pct_int" -ge 50 ]; then bar_color="$C_GOLD"
  else bar_color="$C_MINT"; fi

  ctx_seg="${bar_color}$(mkbar "$used_pct" 10 -1) ${B}${pct_int}%${RST}"
fi


# Duration
dur_seg=""
if [ -n "$duration_ms" ] && [ "$duration_ms" != "null" ]; then
  dur_s=$(( ${duration_ms%.*} / 1000 ))
  mins=$(( dur_s / 60 ))
  secs=$(( dur_s % 60 ))
  if [ "$mins" -gt 0 ]; then
    dur_seg="${C_SKY}${G_CLOCK} ${mins}m${secs}s${RST}"
  else
    dur_seg="${C_SKY}${G_CLOCK} ${secs}s${RST}"
  fi
fi

# Bomb fuse — burns down as context fills, then BOOM
fuse_seg=""
if [ -n "$used_pct" ] && [ "$used_pct" != "null" ]; then
  pct_int=$(printf "%.0f" "$used_pct")
  if [ "$pct_int" -ge 95 ]; then
    fuse_seg="☠️"
  elif [ "$pct_int" -ge 88 ]; then
    fuse_seg="💥"
  elif [ "$pct_int" -ge 78 ]; then
    fuse_seg="${C_RED}🧨━${RST}"
  elif [ "$pct_int" -ge 65 ]; then
    fuse_seg="${C_ORANGE}💣━━✨${RST}"
  elif [ "$pct_int" -ge 45 ]; then
    fuse_seg="${C_GOLD}💣━━━━${RST}"
  elif [ "$pct_int" -ge 25 ]; then
    fuse_seg="${C_MINT}💣━━━━━━${RST}"
  else
    fuse_seg="${C_MINT}💣━━━━━━━━${RST}"
  fi
fi

# Session rank — gamified cost tier
rank_seg=""
if [ -n "$cost_usd" ] && [ "$cost_usd" != "null" ]; then
  cost_cents=$(awk "BEGIN{printf \"%d\", $cost_usd * 100}")
  if [ "$cost_cents" -ge 2500 ]; then rank_seg="👑"
  elif [ "$cost_cents" -ge 1000 ]; then rank_seg="💎"
  elif [ "$cost_cents" -ge 500 ]; then rank_seg="🔥"
  elif [ "$cost_cents" -ge 200 ]; then rank_seg="⚡"
  elif [ "$cost_cents" -ge 50 ]; then rank_seg="🌿"
  else rank_seg="🌱"; fi
fi

# -- Assemble ------------------------------------------------------------------
SEP="${C_DGRAY} │ ${RST}"

# Join non-empty segments with SEP
join_segs() {
  local out="" s
  for s in "$@"; do
    [ -z "$s" ] && continue
    [ -n "$out" ] && out+="$SEP"
    out+="$s"
  done
  printf '%s' "$out"
}

[ -n "$rank_seg" ] && [ -n "$cost_seg" ] && cost_seg="${rank_seg} ${cost_seg}"

# $wallet_seg is only ever set in the work render; join_segs drops it when unset.
line1=$(join_segs "$repo_seg" "$branch_seg" "$changed_seg" "$lines_seg" "$wallet_seg")
line2=$(join_segs "$model_seg" "$agent_seg" "$cost_seg" "$tok_seg" "$ctx_seg" "$dur_seg" "$fuse_seg")
line3=$(join_segs "$quota_5h_seg" "$quota_7d_seg")

printf '%b\n%b\n' "$line1" "$line2"
[ -n "$line3" ] && printf '%b\n' "$line3"
