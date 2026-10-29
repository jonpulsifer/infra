#!/usr/bin/env bash
# Opens, closes or shows the intake window of every anchor's talos-attest: the owner's statement
# that boxes are being racked. open and close write the window's file, an RFC3339 close time, on
# each anchor over ssh as the owner, and talos-attest reads it on every attestation start. status
# reads each anchor's GET /intake through `tailscale serve` on its tailnet name, port 8445, which
# hands the server the caller's tailnet login.
set -euo pipefail

anchors=(spore capsule forge)
window_file=/var/lib/talos-attest/intake-open

usage() {
  echo "usage: fleet-intake.sh open <duration, such as 2h or 1h30m> | close | status" >&2
  exit 64
}

# seconds <duration> prints a duration of hours and minutes, such as 2h, 90m or 1h30m, in seconds.
seconds() {
  [[ "$1" =~ ^([0-9]+h)?([0-9]+m)?$ && -n "$1" ]] || return 1
  local h="${BASH_REMATCH[1]%h}" m="${BASH_REMATCH[2]%m}"
  echo $((${h:-0} * 3600 + ${m:-0} * 60))
}

rfc3339() {
  date -u -d "@$1" +%Y-%m-%dT%H:%M:%SZ 2>/dev/null || date -u -r "$1" +%Y-%m-%dT%H:%M:%SZ
}

suffix="$(tailscale status --json | jq -r '.MagicDNSSuffix // empty')"
[[ -n "$suffix" ]] || {
  echo "tailscale reports no MagicDNS suffix" >&2
  exit 1
}

# on_each <remote command>: runs it as root on every anchor, with this script's stdin copied to
# each, and fails at the end when any anchor failed.
on_each() {
  local input anchor failed=0
  input="$(cat)"
  for anchor in "${anchors[@]}"; do
    if ssh -o BatchMode=yes "$anchor.$suffix" "$1" <<<"$input"; then
      echo "# $anchor: done" >&2
    else
      echo "# $anchor: failed" >&2
      failed=1
    fi
  done
  return "$failed"
}

case "${1:-}" in
  open)
    [[ $# -eq 2 ]] || usage
    secs="$(seconds "$2")" || usage
    ((secs > 0)) || usage
    until="$(rfc3339 $(($(date +%s) + secs)))"
    echo "opening the intake window until $until" >&2
    on_each "sudo install -m 0640 -o talos-attest -g talos-attest /dev/stdin $window_file" <<<"$until"
    ;;
  close)
    [[ $# -eq 1 ]] || usage
    on_each "sudo rm -f $window_file" </dev/null
    ;;
  status)
    [[ $# -eq 1 ]] || usage
    for anchor in "${anchors[@]}"; do
      echo "# $anchor" >&2
      curl -sS --fail-with-body --max-time 10 -H 'Accept: application/json' \
        "https://$anchor.$suffix:8445/intake" | jq -c . || true
    done
    ;;
  *) usage ;;
esac
