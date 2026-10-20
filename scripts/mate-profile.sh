#!/usr/bin/env bash
# Syncs the agent profile that apps/mate bakes from the dotfiles repo's main branch
# into apps/mate/profile. `mise run mate:profile` copies it, and
# `mise run mate:profile:check` fails when the copy has drifted.
set -euo pipefail

readonly REPO=jonpulsifer/dotfiles
readonly DEST=apps/mate/profile
mode=${1:-sync}

tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT
curl -fsSL "https://codeload.github.com/$REPO/tar.gz/refs/heads/main" | tar -xz -C "$tmp" --strip-components=1

sync_pairs() {
  printf '%s\n' \
    "pi/mate/persona.md $DEST/persona.md" \
    ".agents/AGENTS.md $DEST/owner-agents.md" \
    "skills $DEST/skills"
}

status=0
while read -r from to; do
  case $mode in
    sync)
      rm -rf "${to:?}"
      cp -R "$tmp/$from" "$to"
      ;;
    check)
      diff -ru "$to" "$tmp/$from" || status=1
      ;;
    *)
      echo "usage: $0 [sync|check]" >&2
      exit 2
      ;;
  esac
done < <(sync_pairs)
exit "$status"
