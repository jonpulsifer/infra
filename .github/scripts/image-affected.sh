#!/usr/bin/env bash
# Exits 1 when nothing a workspace image is built from changed between two
# commits, and 0 otherwise. A watched path that changed decides it, except the
# root package.json, bun.lock and turbo.json: a change to those counts only when
# `turbo ls --affected` names the image's workspace, because the image installs
# from its own `turbo prune` output, not the whole lockfile. Anything that
# cannot be read counts as a change, so the image builds rather than goes stale.
# detect-containers.sh and cd-stale-images.sh both decide with this.

set -euo pipefail

usage() {
  echo "usage: $0 <base> <head> <workspace> [watch]..." >&2
  exit 64
}

[ "$#" -ge 3 ] || usage
base="$1" head="$2" workspace="$3"
shift 3

affected() {
  echo "$workspace: $1" >&2
  exit 0
}

fail_open() {
  echo "::warning::Cannot tell whether $workspace is affected between $base and $head, so it counts as affected: $1" >&2
  exit 0
}

paths=() root_files=()
for watch in "$@"; do
  case "$watch" in
    package.json | bun.lock | turbo.json) root_files+=("$watch") ;;
    *) paths+=("$watch") ;;
  esac
done

for commit in "$base" "$head"; do
  git cat-file -e "${commit}^{commit}" 2>/dev/null || fail_open "$commit is not a commit in this checkout"
done

# `git diff --quiet` exits 1 for a difference and more for a failure.
differs() {
  local rc=0
  git diff --quiet "$base" "$head" -- "$@" || rc=$?
  case "$rc" in
    0) return 1 ;;
    1) return 0 ;;
    *) fail_open "git diff failed on $*" ;;
  esac
}

if [ "${#paths[@]}" -gt 0 ] && differs "${paths[@]}"; then
  affected "a watched path changed"
fi
if [ "${#root_files[@]}" -eq 0 ] || ! differs "${root_files[@]}"; then
  echo "$workspace: no watched path changed" >&2
  exit 1
fi

# turbo diffs from the merge base, and with none it assumes everything changed.
git merge-base "$base" "$head" >/dev/null 2>&1 \
  || fail_open "no merge base, so the checkout is too shallow"
# turbo reads the lockfile and the package graph from the working tree, not
# from TURBO_SCM_HEAD, so the head has to match the checkout on the root files.
# It also counts uncommitted changes, which can only add packages.
git diff --quiet "$head" -- "${root_files[@]}" 2>/dev/null \
  || fail_open "the checkout's root files differ from $head"

version=$(jq -r '.devDependencies.turbo // empty' package.json 2>/dev/null || true)
[ -n "$version" ] || fail_open "package.json pins no turbo version"

if ! out=$(TURBO_SCM_BASE="$base" TURBO_SCM_HEAD="$head" TURBO_TELEMETRY_DISABLED=1 \
  bunx --bun "turbo@$version" ls --affected --output=json 2>/dev/null); then
  fail_open "turbo@$version ls --affected failed"
fi
listed=$(jq -r --arg ws "$workspace" \
  '.packages.items | if type == "array" then any(.name == $ws) else error("no package list") end' \
  <<<"$out" 2>/dev/null || true)
case "$listed" in
  true) affected "turbo ls --affected names it" ;;
  false)
    echo "$workspace: only root files changed, and turbo ls --affected leaves it out" >&2
    exit 1
    ;;
  *) fail_open "turbo printed no package list" ;;
esac
