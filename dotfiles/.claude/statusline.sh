#!/usr/bin/env bash
# shellcheck disable=SC2154
# Claude Code status line: reads the session JSON on stdin and prints two or three
# lines of [label value] chips. A segment with no data is left out.
# The glyphs need a Nerd Font.

input=$(cat)

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

# The jq `//` defaults are lost when jq is missing or fails and eval gets nothing.
model=${model:-Claude}
cwd=${cwd:-$PWD}

# A value that is not a plain number becomes empty, which the guards below read as absent.
for _f in used_pct total_in total_out cost_usd duration_ms lines_add lines_rm \
          rl_5h_pct rl_5h_reset rl_7d_pct rl_7d_reset; do
  [[ ${!_f} =~ ^-?[0-9]+(\.[0-9]+)?$ ]] || printf -v "$_f" '%s' ""
done

dir_name=$(basename "$cwd")
NOW=$(date +%s)
QUOTA_W=14

# Real escape bytes, printed with %s, so a backslash in a branch name or cwd stays literal.
RST=$'\033[0m'
B=$'\033[1m'
c() { printf '\033[38;5;%dm' "$1"; }
C_PURPLE=$(c 141)
C_LAVEN=$(c 183)
C_SKY=$(c 75)
C_MINT=$(c 114)
C_GOLD=$(c 220)
C_ORANGE=$(c 208)
C_RED=$(c 196)
C_GRAY=$(c 245)
C_DGRAY=$(c 239)

# Raw UTF-8 bytes, because bash 3.2 has no \u escapes.
G_COG=$'\xEF\x82\x85'          # U+F085 nf-fa-cogs
G_GAUGE=$'\xEF\x83\xA4'        # U+F0E4 nf-fa-tachometer
G_AGENT=$'\xEF\x91\xAA'        # U+F46A nf-oct-hubot
G_FILE=$'\xEF\x80\x96'         # U+F016 nf-fa-file_o
G_PLUS=$'\xEF\x91\x97'         # U+F457 nf-oct-diff_added
G_MINUS=$'\xEF\x91\x98'        # U+F458 nf-oct-diff_removed
G_WALLET='🌕'                  # MoonPay's brand moon

fmt_tok() {
  local n=$1
  if [ -z "$n" ] || [ "$n" = "null" ]; then echo "0"; return; fi
  if [ "$n" -ge 1000000 ]; then
    awk -v n="$n" 'BEGIN{printf "%.1fM", n/1000000}'
  elif [ "$n" -ge 1000 ]; then
    awk -v n="$n" 'BEGIN{printf "%.1fk", n/1000}'
  else
    echo "$n"
  fi
}

# $1 percent, may be fractional; $2 width in cells; $3 marker cell, -1 for none.
# Uses the caller's $bar_color.
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
    # The marker recolours its cell, so the fill under it stays visible.
    if [ "$i" = "$mark" ]; then
      bar+="${C_SKY}${cell}${RST}${bar_color}"
    else
      bar+="$cell"
    fi
  done
  printf '%s' "$bar"
}

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

chip() {
  local color=$1 label=$2 value=$3
  printf '%s[%s%s%s %s%s%s%s]%s' \
    "$color" "$RST$C_GRAY" "$label" "$RST" \
    "$color" "$value" "$RST" "$color" "$RST"
}

# $2 is an epoch and $3 a window length, both in seconds.
quota_seg() {
  local pct_raw=$1 reset=$2 window=$3 label=$4
  [ -z "$pct_raw" ] || [ "$pct_raw" = "null" ] && return 0

  local pct left elapsed pace mark left_txt
  pct=$(printf '%.0f' "$pct_raw")

  if [ -z "$reset" ] || [ "$reset" = "null" ]; then
    mark=-1
    left_txt=""
    pace=-1
  else
    left=$(( reset - NOW ))
    [ "$left" -lt 0 ] && left=0
    # A reset more than one window away means the window just started. The clamp
    # also keeps the countdown within 4 columns.
    [ "$left" -gt "$window" ] && left=$window

    # The marker sits at the elapsed share of the window. Usage past it is on pace
    # to run out before the reset.
    elapsed=$(( window - left ))
    pace=$(( elapsed * 100 / window ))
    mark=$(( pace * QUOTA_W / 100 ))
    [ "$mark" -ge "$QUOTA_W" ] && mark=$(( QUOTA_W - 1 ))
    left_txt=$(fmt_left "$left")
  fi

  if [ "$pct" -ge 90 ]; then bar_color="$C_RED"
  elif [ "$pace" -lt 0 ]; then
    # No reset time, so colour on usage alone.
    if [ "$pct" -ge 75 ]; then bar_color="$C_ORANGE"
    elif [ "$pct" -ge 50 ]; then bar_color="$C_GOLD"
    else bar_color="$C_MINT"; fi
  elif [ "$pct" -gt $(( pace + 15 )) ]; then bar_color="$C_ORANGE"
  elif [ "$pct" -gt "$pace" ]; then bar_color="$C_GOLD"
  else bar_color="$C_MINT"; fi

  local val
  val=$(printf '%s %s%d%%%s' \
    "$(mkbar "$pct_raw" "$QUOTA_W" "$mark")" \
    "$B" "$pct" "$RST$bar_color")
  [ -n "$left_txt" ] && val+="${C_DGRAY} ${left_txt}${RST}${bar_color}"
  chip "$bar_color" "$label" "$val"
}

MP_CACHE="${TMPDIR:-/tmp}/claude-statusline-mp-balance"
MP_CACHE_LOCK="${MP_CACHE}.lock"
MP_CACHE_FORCE="${MP_CACHE}.force"
MP_CACHE_TTL=60

# Touch $MP_CACHE_FORCE or set MP_FORCE_REFRESH to force a refresh.
if [ -n "${MP_FORCE_REFRESH:-}" ] || [ -f "$MP_CACHE_FORCE" ]; then
  rm -f "$MP_CACHE" "$MP_CACHE_FORCE"
fi

_refresh_wallet_cache() {
  # One refresh at a time. A lock older than 60 s is stale.
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

  local wallets wallet_name
  wallets=$(mp wallet list --json 2>/dev/null) || { rm -f "$MP_CACHE_LOCK"; return 1; }
  wallet_name=$(echo "$wallets" | jq -r '.[0].name // empty' 2>/dev/null)
  [ -z "$wallet_name" ] && { rm -f "$MP_CACHE_LOCK"; return 1; }

  # One cache line per token: symbol:amount:usd_value
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

  # EMPTY marks a wallet with no token balances.
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
      # Detach the fds, or the child holds the caller's $(...) pipe open and blocks it.
      _refresh_wallet_cache >/dev/null 2>&1 </dev/null &
      disown 2>/dev/null
    fi
    return 0
  fi

  _refresh_wallet_cache >/dev/null 2>&1 </dev/null &
  disown 2>/dev/null
  return 1
}

# A function keeps $cwd quoted when it holds spaces or glob characters.
git_() { git --no-optional-locks -C "$cwd" "$@"; }
GIT_BRANCH="" GIT_REMOTE_URL="" GIT_CHANGED=0
if git_ rev-parse --is-inside-work-tree &>/dev/null; then
  GIT_BRANCH=$(git_ symbolic-ref --short HEAD 2>/dev/null \
    || git_ rev-parse --short HEAD 2>/dev/null || echo "")

  porcelain=$(git_ status --porcelain 2>/dev/null)
  DIRTY=""
  if [ -n "$porcelain" ]; then
    DIRTY="*"
    GIT_CHANGED=$(echo "$porcelain" | wc -l | tr -d ' ')
  fi

  AHEAD_BEHIND=""
  UPSTREAM=$(git_ rev-parse --abbrev-ref '@{upstream}' 2>/dev/null || echo "")
  if [ -n "$UPSTREAM" ]; then
    AHEAD=$(git_ rev-list --count '@{upstream}..HEAD' 2>/dev/null || echo "0")
    BEHIND=$(git_ rev-list --count 'HEAD..@{upstream}' 2>/dev/null || echo "0")
    [ "$AHEAD" -gt 0 ] 2>/dev/null && AHEAD_BEHIND+="↑${AHEAD}"
    [ "$BEHIND" -gt 0 ] 2>/dev/null && AHEAD_BEHIND+="↓${BEHIND}"
  fi

  GIT_REMOTE_URL=$(git_ remote get-url origin 2>/dev/null \
    | sed 's|git@github\.com:|https://github.com/|' \
    | sed 's|\.git$||')
fi

# OSC 8 hyperlink to the remote.
repo_val=""
if [ -n "$GIT_REMOTE_URL" ]; then
  repo_name=$(basename "$GIT_REMOTE_URL")
  repo_val="${B}"$'\033]8;;'"${GIT_REMOTE_URL}"$'\a'"${repo_name}"$'\033]8;;\a'
else
  repo_val="${B}${dir_name}"
fi
repo_seg=$(chip "$C_LAVEN" repo "$repo_val")

git_seg=""
if [ -n "$GIT_BRANCH" ]; then
  git_val="${GIT_BRANCH}${DIRTY}"
  [ -n "$AHEAD_BEHIND" ] && git_val+=" ${AHEAD_BEHIND}"
  [ "$GIT_CHANGED" -gt 0 ] && git_val+=" ${G_FILE}${GIT_CHANGED}"
  if [ -n "$lines_add" ] && [ "$lines_add" != "null" ] && [ -n "$lines_rm" ] && [ "$lines_rm" != "null" ]; then
    if [ "$lines_add" -gt 0 ] || [ "$lines_rm" -gt 0 ]; then
      git_val+=" ${G_PLUS}${lines_add}${G_MINUS}${lines_rm}"
    fi
  fi
  git_seg=$(chip "$C_SKY" git "$git_val")
fi

wallet_seg=""
if wallet_data=$(get_wallet_balance 2>/dev/null); then
  if [ -n "$wallet_data" ] && [ "$wallet_data" != "EMPTY" ]; then
    total=$(awk -F: '{sum+=$3} END{printf "%.2f", sum}' <<< "$wallet_data")
    wallet_seg=$(chip "$C_MINT" wallet "${G_WALLET} \$${total}")
  else
    wallet_seg=$(chip "$C_DGRAY" wallet "🌚 ~\$0")
  fi
fi

quota_5h_seg=$(quota_seg "$rl_5h_pct" "$rl_5h_reset" 18000 5h)
quota_7d_seg=$(quota_seg "$rl_7d_pct" "$rl_7d_reset" 604800 7d)

# effort is empty on models that take no effort level.
model_val="${G_COG} ${model}"
case "$effort" in
  low)    model_val+=" ${G_GAUGE} low" ;;
  medium) model_val+=" ${G_GAUGE} med" ;;
  high)   model_val+=" ${G_GAUGE} high" ;;
  xhigh)  model_val+=" ${G_GAUGE} xhigh" ;;
  max)    model_val+=" ${G_GAUGE} max" ;;
esac
[ -n "$agent_name" ] && model_val+=" ${G_AGENT} ${agent_name}"
model_seg=$(chip "$C_PURPLE" model "$model_val")

rank_seg=""
if [ -n "$cost_usd" ] && [ "$cost_usd" != "null" ]; then
  cost_cents=$(awk -v c="$cost_usd" 'BEGIN{printf "%d", c*100}')
  if [ "$cost_cents" -ge 2500 ]; then rank_seg="👑"
  elif [ "$cost_cents" -ge 1000 ]; then rank_seg="💎"
  elif [ "$cost_cents" -ge 500 ]; then rank_seg="🔥"
  elif [ "$cost_cents" -ge 200 ]; then rank_seg="⚡"
  elif [ "$cost_cents" -ge 50 ]; then rank_seg="🌿"
  else rank_seg="🌱"; fi
fi

cost_seg=""
if [ -n "$cost_usd" ] && [ "$cost_usd" != "null" ]; then
  cost_fmt=$(printf '%.2f' "$cost_usd")
  cost_val="\$${cost_fmt}"
  [ -n "$rank_seg" ] && cost_val="${rank_seg} ${cost_val}"
  if [ -n "$total_in" ] && [ "$total_in" != "null" ]; then
    total_out_safe=${total_out:-0}
    [ "$total_out_safe" = "null" ] && total_out_safe=0
    # awk, because JSON numbers may be fractional and $(( )) is integer-only.
    grand_fmt=$(fmt_tok "$(awk -v a="$total_in" -v b="$total_out_safe" 'BEGIN{printf "%d", a+b}')")
    cost_val+=" · ${grand_fmt} tok"
  fi
  cost_seg=$(chip "$C_GOLD" cost "$cost_val")
fi

dur_seg=""
if [ -n "$duration_ms" ] && [ "$duration_ms" != "null" ]; then
  dur_s=$(awk -v m="$duration_ms" 'BEGIN{printf "%d", m/1000}')
  mins=$(( dur_s / 60 ))
  secs=$(( dur_s % 60 ))
  if [ "$mins" -gt 0 ]; then
    dur_seg=$(chip "$C_DGRAY" dur "${mins}m${secs}s")
  else
    dur_seg=$(chip "$C_DGRAY" dur "${secs}s")
  fi
fi

ctx_seg=""
if [ -n "$used_pct" ] && [ "$used_pct" != "null" ]; then
  pct_int=$(printf "%.0f" "$used_pct")
  if [ "$pct_int" -ge 90 ]; then bar_color="$C_RED"
  elif [ "$pct_int" -ge 70 ]; then bar_color="$C_ORANGE"
  elif [ "$pct_int" -ge 50 ]; then bar_color="$C_GOLD"
  else bar_color="$C_MINT"; fi

  if [ "$pct_int" -ge 95 ]; then
    fuse="☠️"
  elif [ "$pct_int" -ge 88 ]; then
    fuse="💥"
  elif [ "$pct_int" -ge 78 ]; then
    fuse="🧨━"
  elif [ "$pct_int" -ge 65 ]; then
    fuse="💣━━✨"
  elif [ "$pct_int" -ge 45 ]; then
    fuse="💣━━━━"
  elif [ "$pct_int" -ge 25 ]; then
    fuse="💣━━━━━━"
  else
    fuse="💣━━━━━━━━"
  fi

  ctx_seg=$(chip "$bar_color" ctx "$(mkbar "$used_pct" 10 -1) ${pct_int}% ${fuse}")
fi

join_segs() {
  local out="" s
  for s in "$@"; do
    [ -z "$s" ] && continue
    [ -n "$out" ] && out+=" "
    out+="$s"
  done
  printf '%s' "$out"
}

line1=$(join_segs "$repo_seg" "$git_seg" "$wallet_seg")
line2=$(join_segs "$model_seg" "$cost_seg" "$ctx_seg" "$dur_seg")
line3=$(join_segs "$quota_5h_seg" "$quota_7d_seg")

printf '%s\n%s\n' "$line1" "$line2"
if [ -n "$line3" ]; then
  printf '%s\n' "$line3"
fi
