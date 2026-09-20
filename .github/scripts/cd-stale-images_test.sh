#!/usr/bin/env bash
# Covers what the reconcile path decides: whether a pinned build is behind the
# newest commit that touched the image it belongs to, and which images that
# makes stale.
#
# Nothing here reaches the network. The commit graph is a real repository on
# disk, because every verdict is an ancestry question and a fixture that fakes
# `git` would be testing the fixture. The registry read and the watch map are
# stubs, injected through the same environment variables the workflow leaves
# unset.
#
# The cases that matter are the ones where the answer must be `current`
# although the pin is old: a digest already queued on its delivery branch, and
# a digest whose provenance cannot be read. Both are how a daily rebuild turns
# into a daily rebuild *forever*, so both are asserted rather than assumed.

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

# --- a repository with a real history ---------------------------------------

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

# --- newest ------------------------------------------------------------------

assert_equal 'newest names the last commit touching a path' \
  "$latest_foo" "$("$script" newest apps/foo)"

assert_equal 'newest ignores commits that touched nothing it was asked about' \
  "$bar_only" "$("$script" newest apps/bar)"

assert_equal 'newest spans every path an image watches' \
  "$latest_foo" "$("$script" newest apps/foo apps/bar)"

assert_equal 'newest is silent about a path no commit ever touched' \
  '' "$("$script" newest apps/nothing)"

# --- verdict -----------------------------------------------------------------

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

# --- stubs for the whole-image pass -----------------------------------------

fixtures="$work/fixtures"
mkdir -p "$fixtures"/{pins,queued,revision}
export FIXTURES="$fixtures"

# `pins`, `pins-at` and `revision`, driven by files so each case can set up the
# registry and the delivery branch it needs. The argument positions are the
# real script's: `pins <image> <manifest>...`, `pins-at <ref> <image>
# <manifest>...`, `revision <repository> <digest>`.
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
    "foo": ["deploy/foo.yaml"],
    "bar": ["deploy/bar.yaml"]
  },
  "ignore": []
}
JSON

export CD_DIGEST_UPDATE="$work/cd-digest-update.sh"
export DETECT_CONTAINERS="$work/detect-containers.sh"
export CONTAINERS_MANIFEST="$work/containers.json"
export REGISTRY_OWNER=tester

# One digest per build, so an image is never accidentally asserted against
# another image's provenance. `foo` watches apps/foo, whose newest commit is
# $latest_foo; `bar` watches apps/bar, whose newest is $bar_only.
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

# An image pinned at a build of a commit older than the last one to touch it is
# exactly the dropped build this exists to find — and its up-to-date neighbour
# in the same pass is not dragged along with it.
reset_fixtures
printf '%s\n' "$foo_old" >"$fixtures/pins/foo"
printf '%s\n' "$bar_new" >"$fixtures/pins/bar"
assert_equal 'an image pinned behind its newest input commit is named' \
  foo "$("$script" stale 2>/dev/null)"

# The steady state, which is most days: nothing to do, and nothing printed.
reset_fixtures
printf '%s\n' "$foo_new" >"$fixtures/pins/foo"
printf '%s\n' "$bar_new" >"$fixtures/pins/bar"
assert_equal 'an image pinned at its newest input commit is left alone' \
  '' "$("$script" stale 2>/dev/null)"

# A build that already ran and is waiting on its delivery pull request has got
# here first. Rebuilding on top of it would be the daily-churn failure.
reset_fixtures
printf '%s\n' "$foo_old" >"$fixtures/pins/foo"
printf '%s\n' "$foo_new" >"$fixtures/queued/foo"
assert_equal 'a newer digest queued but not merged counts as current' \
  '' "$("$script" stale foo 2>/dev/null)"

# No revision label means no proof, and no proof means no rebuild.
reset_fixtures
printf '%s\n' "$unlabelled" >"$fixtures/pins/foo"
assert_equal 'a pin whose provenance cannot be read is never rebuilt' \
  '' "$("$script" stale foo 2>/dev/null)"

warning=$("$script" stale foo 2>&1 >/dev/null)
grep -q '^::warning::' <<<"$warning" \
  || fail 'an unreadable pin should warn rather than pass in silence'

# One unreadable digest alongside one that is behind is still not proof: the
# unreadable one could be the newer build.
reset_fixtures
printf '%s\n%s\n' "$foo_old" "$unlabelled" >"$fixtures/pins/foo"
assert_equal 'a single unreadable candidate withdraws the whole verdict' \
  '' "$("$script" stale foo 2>/dev/null)"

# Nothing pins an image with no deploy target, so it has no staleness to read.
reset_fixtures
printf '%s\n' "$foo_old" >"$fixtures/pins/orphan"
assert_equal 'an image nothing deploys is not stale' \
  '' "$("$script" stale orphan 2>/dev/null)"

# A manifest that pins no digest at all cannot roll, and saying so is more use
# than rebuilding into a file that will never carry the result.
reset_fixtures
assert_equal 'an image whose manifests pin nothing is reported, not rebuilt' \
  '' "$("$script" stale foo 2>/dev/null)"

# A shallow checkout can name a newest commit, and it would be the wrong one.
# Refusing there is what keeps the schedule from rebuilding the world.
shallow="$work/shallow"
git clone -q --depth 1 "file://$repo" "$shallow"
cd "$shallow"
assert_equal 'a shallow checkout tells nothing rather than something wrong' \
  unknown "$("$script" verdict "$first" "$latest_foo" 2>/dev/null)"
assert_equal 'a shallow checkout names no newest commit' \
  '' "$("$script" newest apps/foo 2>/dev/null)"
cd "$repo"

echo 'cd-stale-images: all assertions passed'
