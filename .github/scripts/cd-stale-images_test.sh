#!/usr/bin/env bash
# Tests cd-stale-images.sh against a real commit graph on disk. The registry
# read and the watch map are stubs set through the script's override variables.

set -euo pipefail

script="$(cd "$(dirname "$0")" && pwd)/cd-stale-images.sh"
work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT

export GIT_CONFIG_GLOBAL="$work/gitconfig"
export GIT_CONFIG_SYSTEM=/dev/null
: >"$GIT_CONFIG_GLOBAL"

fail() {
  printf 'FAIL: %s\n' "$1" >&2
  exit 1
}

assert_equal() {
  local name="$1" expected="$2" actual="$3"
  if [[ "$actual" != "$expected" ]]; then
    printf 'FAIL: %s\nexpected:\n%s\nactual:\n%s\n' "$name" "$expected" "$actual" >&2
    exit 1
  fi
}

repo="$work/repo"
mkdir -p "$repo"
cd "$repo"
git init -q -b main .
git config user.name tester
git config user.email tester@example.invalid

commit() {
  local path="$1" message="$2"
  mkdir -p "$(dirname "$path")"
  echo "$message" >>"$path"
  git add -- "$path"
  git commit -qm "$message"
  git rev-parse HEAD
}

first=$(commit apps/foo/main.ts 'foo one')
bar_only=$(commit apps/bar/main.ts 'bar one')
latest_foo=$(commit apps/foo/other.ts 'foo two')
untouched=$(commit docs/notes.md 'docs only')

assert_equal 'newest names the last commit touching a path' \
  "$latest_foo" "$("$script" newest apps/foo)"

assert_equal 'newest ignores commits that touched nothing it was asked about' \
  "$bar_only" "$("$script" newest apps/bar)"

assert_equal 'newest spans every path an image watches' \
  "$latest_foo" "$("$script" newest apps/foo apps/bar)"

assert_equal 'newest is silent about a path no commit ever touched' \
  '' "$("$script" newest apps/nothing)"

assert_equal 'a pin strictly behind the newest input commit is stale' \
  stale "$("$script" verdict "$first" "$latest_foo")"

assert_equal 'a pin on the newest input commit is current' \
  current "$("$script" verdict "$latest_foo" "$latest_foo")"

assert_equal 'a pin ahead of the newest input commit is current' \
  current "$("$script" verdict "$untouched" "$latest_foo")"

assert_equal 'a pin on a commit that is not an ancestor is left alone' \
  current "$("$script" verdict "$latest_foo" "$bar_only")"

assert_equal 'an unreadable pin is unknown, never stale' \
  unknown "$("$script" verdict '' "$latest_foo")"

assert_equal 'a pin with no input commit to compare against is unknown' \
  unknown "$("$script" verdict "$first" '')"

assert_equal 'a pin on a commit this checkout does not have is unknown' \
  unknown \
  "$("$script" verdict 0000000000000000000000000000000000000000 "$latest_foo" 2>/dev/null)"

fixtures="$work/fixtures"
mkdir -p "$fixtures"/{pins,queued,revision}
export FIXTURES="$fixtures"

# Answers `pins`, `pins-at` and `revision` from fixture files, with the real
# script's argument positions.
cat >"$work/cd-digest-update.sh" <<'STUB'
#!/usr/bin/env bash
set -euo pipefail
case "$1" in
  pins) cat "$FIXTURES/pins/$2" 2>/dev/null || true ;;
  pins-at) cat "$FIXTURES/queued/$3" 2>/dev/null || true ;;
  revision) cat "$FIXTURES/revision/$3" 2>/dev/null || true ;;
  *) exit 64 ;;
esac
STUB
chmod +x "$work/cd-digest-update.sh"

cat >"$work/detect-containers.sh" <<'STUB'
#!/usr/bin/env bash
set -euo pipefail
[ "${1:-}" = "--watches" ] || exit 64
cat "$FIXTURES/watches"
STUB
chmod +x "$work/detect-containers.sh"

printf 'foo\tapps/foo\nbar\tapps/bar\n' >"$fixtures/watches"

cat >"$work/containers.json" <<'JSON'
{
  "build": ["foo", "bar", "orphan"],
  "deploy": {
    "foo": ["deploy/foo.yaml", "deploy/foo-other.yaml"],
    "bar": ["deploy/bar.yaml"]
  },
  "ignore": []
}
JSON

export CD_DIGEST_UPDATE="$work/cd-digest-update.sh"
export DETECT_CONTAINERS="$work/detect-containers.sh"
export CONTAINERS_MANIFEST="$work/containers.json"
export REGISTRY_OWNER=tester

# One digest per build. The newest input commit of foo is $latest_foo, and of
# bar is $bar_only.
foo_old='sha256:1111111111111111111111111111111111111111111111111111111111111111'
foo_new='sha256:2222222222222222222222222222222222222222222222222222222222222222'
bar_new='sha256:4444444444444444444444444444444444444444444444444444444444444444'
unlabelled='sha256:3333333333333333333333333333333333333333333333333333333333333333'

reset_fixtures() {
  rm -f "$fixtures"/pins/* "$fixtures"/queued/* "$fixtures"/revision/*
  printf '%s\n' "$first" >"$fixtures/revision/$foo_old"
  printf '%s\n' "$latest_foo" >"$fixtures/revision/$foo_new"
  printf '%s\n' "$bar_only" >"$fixtures/revision/$bar_new"
  : >"$fixtures/revision/$unlabelled"
}

# bar is current in the same pass and must not be named with foo.
reset_fixtures
printf '%s\n' "$foo_old" >"$fixtures/pins/foo"
printf '%s\n' "$bar_new" >"$fixtures/pins/bar"
assert_equal 'an image pinned behind its newest input commit is named' \
  foo "$("$script" stale 2>/dev/null)"

reset_fixtures
printf '%s\n' "$foo_new" >"$fixtures/pins/foo"
printf '%s\n' "$bar_new" >"$fixtures/pins/bar"
assert_equal 'an image pinned at its newest input commit is left alone' \
  '' "$("$script" stale 2>/dev/null)"

reset_fixtures
printf '%s\n%s\n' "$foo_old" "$foo_new" >"$fixtures/pins/foo"
assert_equal 'a main pin behind names the image although another main pin is current' \
  foo "$("$script" stale foo 2>/dev/null)"

reset_fixtures
printf '%s\n' "$foo_old" >"$fixtures/pins/foo"
printf '%s\n' "$foo_new" >"$fixtures/queued/foo"
assert_equal 'a newer digest queued but not merged counts as current' \
  '' "$("$script" stale foo 2>/dev/null)"

reset_fixtures
printf '%s\n' "$unlabelled" >"$fixtures/pins/foo"
assert_equal 'a pin whose provenance cannot be read is never rebuilt' \
  '' "$("$script" stale foo 2>/dev/null)"

warning=$("$script" stale foo 2>&1 >/dev/null)
grep -q '^::warning::' <<<"$warning" \
  || fail 'an unreadable pin should warn rather than pass in silence'

# The unreadable digest could be the newer build.
reset_fixtures
printf '%s\n%s\n' "$foo_old" "$unlabelled" >"$fixtures/pins/foo"
assert_equal 'a single unreadable candidate withdraws the whole verdict' \
  '' "$("$script" stale foo 2>/dev/null)"

reset_fixtures
printf '%s\n' "$foo_old" >"$fixtures/pins/orphan"
assert_equal 'an image nothing deploys is not stale' \
  '' "$("$script" stale orphan 2>/dev/null)"

reset_fixtures
assert_equal 'an image whose manifests pin nothing is reported, not rebuilt' \
  '' "$("$script" stale foo 2>/dev/null)"

# A shallow clone's newest commit depends on the fetch depth.
shallow="$work/shallow"
git clone -q --depth 1 "file://$repo" "$shallow"
cd "$shallow"
assert_equal 'a shallow checkout tells nothing rather than something wrong' \
  unknown "$("$script" verdict "$first" "$latest_foo" 2>/dev/null)"
assert_equal 'a shallow checkout names no newest commit' \
  '' "$("$script" newest apps/foo 2>/dev/null)"
cd "$repo"

# Both commits exist, the older as another branch's tip, but main's history
# stops at a graft, so merge-base finds no path between them.
git -C "$repo" branch -q built-here "$first"
truncated="$work/truncated"
git clone -q --depth 2 --no-single-branch "file://$repo" "$truncated"
cd "$truncated"
git cat-file -e "$first^{commit}" 2>/dev/null \
  || fail 'fixture drift: the truncated clone no longer holds the pinned commit'
git cat-file -e "$latest_foo^{commit}" 2>/dev/null \
  || fail 'fixture drift: the truncated clone no longer holds the newest commit'
if git merge-base --is-ancestor "$first" "$latest_foo" 2>/dev/null; then
  fail 'fixture drift: this clone answers ancestry correctly, so it no longer reaches the guard'
fi
assert_equal 'a truncated graph holding both commits is unknown, not a confident wrong answer' \
  unknown "$("$script" verdict "$first" "$latest_foo" 2>/dev/null)"
cd "$repo"

echo 'cd-stale-images: all assertions passed'
