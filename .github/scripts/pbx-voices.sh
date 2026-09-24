#!/usr/bin/env bash
# Renders each line of clusters/folly/apps/pbx/sounds/lines.yaml to <id>.ulaw
# beside it with ElevenLabs text-to-speech, as 8 kHz mu-law Asterisk plays as is.
#
# Usage: pbx-voices.sh [--all | <id>...]. With no argument it renders the lines
# that have no .ulaw yet. PBX_VOICES_KEY_REF overrides the 1Password reference
# of the API key, which reaches curl on a file descriptor, never on argv.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
DIR="$ROOT/clusters/folly/apps/pbx/sounds"
LINES="$DIR/lines.yaml"
KUSTOMIZATION="$ROOT/clusters/folly/apps/pbx/kustomization.yaml"
MODEL=eleven_flash_v2
KEY_REF=${PBX_VOICES_KEY_REF:-op://homelab/rowbutt elevenlabs api key/password}
# Every prompt shares the pbx-sounds ConfigMap, and Kubernetes refuses one over
# 1 MiB; this leaves room to grow.
BUDGET=$((700 * 1024))

die() {
  printf 'pbx-voices: %s\n' "$*" >&2
  exit 1
}

for tool in curl jq op yq; do
  command -v "$tool" >/dev/null || die "$tool is required"
done

mapfile -t ids < <(yq '.lines[].id' "$LINES")
((${#ids[@]})) || die "$LINES declares no lines"

want=()
case ${1:-} in
  --all) want=("${ids[@]}") ;;
  "")
    for id in "${ids[@]}"; do
      [[ -s $DIR/$id.ulaw ]] || want+=("$id")
    done
    ;;
  *)
    for id in "$@"; do
      printf '%s\n' "${ids[@]}" | grep -qxF -- "$id" || die "no line '$id' in $LINES"
      want+=("$id")
    done
    ;;
esac

if ((${#want[@]})); then
  key=$(op read "$KEY_REF") || die "could not read the ElevenLabs key from 1Password"
  [[ -n $key ]] || die "the ElevenLabs key at $KEY_REF is empty"
  tmp=$(mktemp -d)
  trap 'rm -rf "$tmp"' EXIT

  for id in "${want[@]}"; do
    ID="$id" yq -o=json '.lines[] | select(.id == strenv(ID))' "$LINES" >"$tmp/line.json"
    voice=$(jq -r .voice_id "$tmp/line.json")
    jq --arg model "$MODEL" '{text, model_id: $model}' "$tmp/line.json" >"$tmp/body.json"
    status=$(curl -sS --max-time 60 -o "$tmp/out" -w '%{http_code}' \
      -H @<(printf 'xi-api-key: %s\n' "$key") \
      -H 'Content-Type: application/json' \
      --data-binary @"$tmp/body.json" \
      "https://api.elevenlabs.io/v1/text-to-speech/$voice?output_format=ulaw_8000")
    [[ $status == 200 ]] || die "$id: HTTP $status: $(head -c 300 "$tmp/out")"
    mv "$tmp/out" "$DIR/$id.ulaw"
    printf '%-22s %7d bytes\n' "$id" "$(wc -c <"$DIR/$id.ulaw")"
  done
fi

total=0
for f in "$DIR"/*.ulaw; do
  [[ -e $f ]] || continue
  id=$(basename "$f" .ulaw)
  printf '%s\n' "${ids[@]}" | grep -qxF -- "$id" || printf 'pbx-voices: %s has no line in lines.yaml\n' "$f" >&2
  grep -qF "sounds/$id.ulaw" "$KUSTOMIZATION" || printf 'pbx-voices: add sounds/%s.ulaw to pbx-sounds in %s\n' "$id" "$KUSTOMIZATION" >&2
  total=$((total + $(wc -c <"$f")))
done
printf 'total %d bytes of a %d byte budget\n' "$total" "$BUDGET"
((total <= BUDGET)) || die "the prompts are over budget; shorten or drop lines"
