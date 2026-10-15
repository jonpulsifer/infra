#!/usr/bin/env bash
# Exits 0 when every file is a CD deploy target in .github/containers.json that
# differs only at its first-party image digest line and still pins one.
# usage: digest-only.sh <base> <head> <file>...

set -euo pipefail

base=$1 head=$2
shift 2
re='^[[:space:]]*image: ghcr\.io/jonpulsifer/[a-z0-9-]+:latest@sha256:[[:xdigit:]]{64}$'

declare -A targets=()
while IFS= read -r target; do
  targets[$target]=1
done < <(jq -r '.deploy[][]' .github/containers.json)

for f in "$@"; do
  [[ -n "${targets[$f]:-}" ]] || exit 1
  git diff --quiet --ignore-matching-lines="$re" "$base" "$head" -- "$f" || exit 1
  # Read through a process substitution: under pipefail, `grep -q` closing the
  # pipe early would fail a match with SIGPIPE.
  grep -Eq "$re" < <(git show "$head:$f" 2>/dev/null) || exit 1
done
