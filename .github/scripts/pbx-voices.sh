#!/usr/bin/env bash
# Renders the PBX's recorded prompts. Each line of
# clusters/folly/apps/pbx/sounds/lines.yaml becomes <id>.ulaw beside it,
# spoken by ElevenLabs text-to-speech as 8 kHz mu-law, the format Asterisk
# plays to a G.711 or G.722 call without a file conversion.
#
# Usage: pbx-voices.sh [--all | <id>...]. With no argument, only the lines
# that have no clip yet. Speech is not deterministic, so re-rendering a line
# is a new recording to listen to, not a no-op.
#
# The key is the password of 1Password item "rowbutt elevenlabs api key" in the
# homelab vault. It is read once and handed to curl on stdin, so it never
# reaches argv, the terminal or a file.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
SOUNDS="$ROOT/clusters/folly/apps/pbx/sounds"
LINES="$SOUNDS/lines.yaml"
KUSTOMIZATION="$ROOT/clusters/folly/apps/pbx/kustomization.yaml"
API=https://api.elevenlabs.io/v1/text-to-speech
MODEL=eleven_flash_v2
# Every clip ships in one ConfigMap, which Kubernetes caps at 1 MiB.
BUDGET=$((700 * 1024))
# Mu-law bytes quieter than this are the silence trimmed from each end, less
# PAD bytes (0.15 s at 8000 bytes a second) kept either side.
QUIET=24
PAD=1200

die() {
  printf 'pbx-voices: %s\n' "$*" >&2
  exit 1
}

# id<TAB>voice_id<TAB>text, one line each.
entries() { yq -r 'explode(.) | .lines[] | [.id, .voice_id, .text] | @tsv' "$LINES"; }

# Mu-law stores the inverted magnitude, so 255 - byte, less its sign bit, is
# the loudness: 0 is silence.
trim() {
  local file=$1 first last size start end
  read -r first last < <(od -An -v -tu1 -w1 "$file" | awk -v quiet="$QUIET" '
    { if ((255 - $1) % 128 >= quiet) { if (!first) first = NR; last = NR } }
    END { print first + 0, last + 0 }
  ')
  ((last > 0)) || die "$(basename "$file"): the clip is silent"
  size=$(wc -c <"$file")
  start=$((first > PAD ? first - PAD : 1))
  end=$((last + PAD < size ? last + PAD : size))
  tail -c +"$start" "$file" | head -c $((end - start + 1)) >"$file.trim"
  mv "$file.trim" "$file"
}

render() {
  local id=$1 voice=$2 text=$3 out="$SOUNDS/$1.ulaw" status
  local tmp="$out.part"
  status=$(jq -n --arg text "$text" --arg model "$MODEL" '{text: $text, model_id: $model}' \
    | curl -sS -m 60 -o "$tmp" -w '%{http_code}' \
      -H @<(printf 'xi-api-key: %s\n' "$KEY") \
      -H 'Content-Type: application/json' \
      --data-binary @- \
      "$API/$voice?output_format=ulaw_8000")
  if [[ $status != 200 ]]; then
    printf 'pbx-voices: %s: HTTP %s: %s\n' "$id" "$status" "$(head -c 300 "$tmp")" >&2
    rm -f "$tmp"
    exit 1
  fi
  [[ $(head -c 4 "$tmp") != RIFF ]] || die "$id: the API sent a WAV file, not raw mu-law"
  trim "$tmp"
  mv "$tmp" "$out"
  printf '  %-18s %6d bytes  %s\n' "$id" "$(wc -c <"$out")" "$text"
}

main() {
  local all=0 id voice text total
  local -a wanted=("$@") listed=() missing=()
  if [[ ${1:-} == --all ]]; then
    all=1
    wanted=()
  fi

  local -A known=()
  while IFS=$'\t' read -r id voice text; do known[$id]=1; done < <(entries)
  for id in "${wanted[@]}"; do [[ -n ${known[$id]:-} ]] || die "no line '$id' in $LINES"; done

  local -a todo=()
  while IFS=$'\t' read -r id voice text; do
    if ((all)) || { ((${#wanted[@]} == 0)) && [[ ! -s $SOUNDS/$id.ulaw ]]; } || [[ " ${wanted[*]} " == *" $id "* ]]; then
      todo+=("$id")
    fi
  done < <(entries)

  if ((${#todo[@]})); then
    command -v op >/dev/null || die "the 1Password CLI (op) is required"
    KEY=$(op read "op://homelab/rowbutt elevenlabs api key/password")
    [[ -n $KEY ]] || die "the ElevenLabs key is empty"
    while IFS=$'\t' read -r id voice text; do
      if [[ " ${todo[*]} " == *" $id "* ]]; then render "$id" "$voice" "$text"; fi
    done < <(entries)
  fi

  mapfile -t listed < <(yq -r '.configMapGenerator[] | select(.name == "pbx-sounds") | .files[]' "$KUSTOMIZATION")
  while IFS=$'\t' read -r id voice text; do
    [[ -s $SOUNDS/$id.ulaw ]] || die "$id has no clip; run with no argument to render it"
    [[ " ${listed[*]} " == *" sounds/$id.ulaw "* ]] || missing+=("sounds/$id.ulaw")
  done < <(entries)
  if ((${#missing[@]})); then
    die "add these to the pbx-sounds generator in $KUSTOMIZATION: ${missing[*]}"
  fi
  for id in "$SOUNDS"/*.ulaw; do
    id=$(basename "$id" .ulaw)
    [[ -n ${known[$id]:-} ]] || printf 'pbx-voices: %s.ulaw has no line in lines.yaml\n' "$id" >&2
  done

  total=$(cat "$SOUNDS"/*.ulaw | wc -c)
  ((total <= BUDGET)) || die "the clips total $total bytes, over the $BUDGET-byte budget; shorten a line"
  printf 'pbx-voices: %d clips, %d bytes of %d\n' "${#known[@]}" "$total" "$BUDGET"
}

main "$@"
