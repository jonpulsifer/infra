#!/usr/bin/env bash
# Tests cd-stale-images.sh against a real commit graph on disk. The registry
# read, the watch map and image-affected.sh are stubs set through the script's
# override variables.

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
ws_source=$(commit apps/ws/main.ts 'ws one')
ws_lock=$(commit bun.lock 'a lockfile bump')
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
mkdir -p "$fixtures"/{pins,queued,revision,fingerprint}
export FIXTURES="$fixtures"

# Answers `pins`, `queued`, `revision` and `fingerprint` from fixture files,
# with the real script's argument positions. The last two take a digest or a
# tag, and a missing file is a tag the registry does not have.
cat >"$work/cd-digest-update.sh" <<'STUB'
#!/usr/bin/env bash
set -euo pipefail
case "$1" in
  pins) cat "$FIXTURES/pins/$2" 2>/dev/null || true ;;
  queued) cat "$FIXTURES/queued/${2#refs/cd/queued/}/$3" 2>/dev/null || true ;;
  revision) cat "$FIXTURES/revision/$3" 2>/dev/null || true ;;
  fingerprint) cat "$FIXTURES/fingerprint/$3" 2>/dev/null || true ;;
  *) exit 64 ;;
esac
STUB
chmod +x "$work/cd-digest-update.sh"

cat >"$work/detect-containers.sh" <<'STUB'
#!/usr/bin/env bash
set -euo pipefail
case "${1:-}" in
  --watches) cat "$FIXTURES/watches" ;;
  --workspaces) cat "$FIXTURES/workspaces" ;;
  *) exit 64 ;;
esac
STUB
chmod +x "$work/detect-containers.sh"

# Logs its arguments and exits with the code in the `affected` fixture: 0 for
# affected, 1 for not affected, anything else for a failure.
cat >"$work/image-affected.sh" <<'STUB'
#!/usr/bin/env bash
printf '%s\n' "$*" >>"$FIXTURES/affected-calls"
exit "$(cat "$FIXTURES/affected")"
STUB
chmod +x "$work/image-affected.sh"

printf 'foo\tapps/foo\nbar\tapps/bar\nws\tapps/ws\nws\tbun.lock\n' >"$fixtures/watches"
printf 'ws\tws\n' >"$fixtures/workspaces"

cat >"$work/containers.json" <<'JSON'
{
  "build": ["foo", "bar", "ws", "orphan"],
  "deploy": {
    "foo": ["deploy/foo.yaml", "deploy/foo-other.yaml"],
    "bar": ["deploy/bar.yaml"],
    "ws": ["deploy/ws.yaml"]
  },
  "ignore": []
}
JSON

export CD_DIGEST_UPDATE="$work/cd-digest-update.sh"
export DETECT_CONTAINERS="$work/detect-containers.sh"
export IMAGE_AFFECTED="$work/image-affected.sh"
export CONTAINERS_MANIFEST="$work/containers.json"
export REGISTRY_OWNER=tester

# One digest per build. The newest input commit of foo is $latest_foo, and of
# bar is $bar_only.
foo_old='sha256:1111111111111111111111111111111111111111111111111111111111111111'
foo_new='sha256:2222222222222222222222222222222222222222222222222222222222222222'
bar_new='sha256:4444444444444444444444444444444444444444444444444444444444444444'
unlabelled='sha256:3333333333333333333333333333333333333333333333333333333333333333'
ws_old='sha256:5555555555555555555555555555555555555555555555555555555555555555'
ws_src='sha256:6666666666666666666666666666666666666666666666666666666666666666'

reset_fixtures() {
  rm -rf "$fixtures"/queued/*
  mkdir -p "$fixtures/queued/update-digests"
  rm -f "$fixtures"/pins/* "$fixtures"/revision/* "$fixtures"/fingerprint/* "$fixtures"/affected*
  printf '%s\n' "$first" >"$fixtures/revision/$foo_old"
  printf '%s\n' "$latest_foo" >"$fixtures/revision/$foo_new"
  printf '%s\n' "$bar_only" >"$fixtures/revision/$bar_new"
  printf '%s\n' "$bar_only" >"$fixtures/revision/$ws_old"
  printf '%s\n' "$ws_source" >"$fixtures/revision/$ws_src"
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
printf '%s\n' "$foo_new" >"$fixtures/queued/update-digests/foo"
assert_equal 'a newer digest queued but not merged counts as current' \
  '' "$("$script" stale foo 2>/dev/null)"

reset_fixtures
mkdir -p "$fixtures/queued/update-foo-digest"
printf '%s\n' "$foo_old" >"$fixtures/pins/foo"
printf '%s\n' "$foo_new" >"$fixtures/queued/update-foo-digest/foo"
assert_equal 'a newer digest queued on the per-image branch still counts as current' \
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

# ws names its workspace, so image-affected.sh decides a pin that ancestry
# calls stale. Its newest input commit is $ws_lock.
reset_fixtures
printf '%s\n' "$ws_src" >"$fixtures/pins/ws"
echo 1 >"$fixtures/affected"
assert_equal 'a lockfile commit that leaves the workspace unaffected keeps the pin current' \
  '' "$("$script" stale ws 2>/dev/null)"
assert_equal 'the workspace check spans the pin to the newest input commit' \
  "$ws_source $ws_lock ws apps/ws bun.lock" "$(cat "$fixtures/affected-calls")"

reset_fixtures
printf '%s\n' "$ws_src" >"$fixtures/pins/ws"
echo 0 >"$fixtures/affected"
assert_equal 'a lockfile commit that affects the workspace makes the pin stale' \
  ws "$("$script" stale ws 2>/dev/null)"

reset_fixtures
printf '%s\n' "$ws_old" >"$fixtures/pins/ws"
echo 0 >"$fixtures/affected"
assert_equal 'a source change since the pin makes it stale' \
  ws "$("$script" stale ws 2>/dev/null)"
assert_equal 'the workspace check starts at the pinned commit' \
  "$bar_only $ws_lock ws apps/ws bun.lock" "$(cat "$fixtures/affected-calls")"

reset_fixtures
printf '%s\n' "$ws_src" >"$fixtures/pins/ws"
echo 2 >"$fixtures/affected"
assert_equal 'a workspace check that fails counts the pin as stale' \
  ws "$("$script" stale ws 2>/dev/null)"

reset_fixtures
printf '%s\n' "$foo_old" >"$fixtures/pins/foo"
printf '%s\n' "$bar_new" >"$fixtures/pins/bar"
echo 1 >"$fixtures/affected"
assert_equal 'an image with no workspace is decided by ancestry alone' \
  foo "$("$script" stale foo bar 2>/dev/null)"
assert_equal 'an image with no workspace is never asked about one' \
  '' "$(cat "$fixtures/affected-calls" 2>/dev/null || true)"

# foo is pinned behind $latest_foo, and the build tagged with that commit is
# compared by content. `same` and `other` stand for two fingerprints.
foo_mid='sha256:7777777777777777777777777777777777777777777777777777777777777777'
foo_queued='sha256:8888888888888888888888888888888888888888888888888888888888888888'
content() { printf '%s\n' "$2" >"$fixtures/fingerprint/$1"; }

reset_fixtures
printf '%s\n' "$foo_old" >"$fixtures/pins/foo"
content "$foo_old" same
content "$latest_foo" same
assert_equal 'a pin with the content of the newest build is current' \
  '' "$("$script" stale foo 2>/dev/null)"
grep -qx 'foo is pinned at content identical to the newest build.' <<<"$("$script" stale foo 2>&1 >/dev/null)" \
  || fail 'a content match passed in silence'

content "$latest_foo" other
assert_equal 'a pin whose content differs from the newest build is stale' \
  foo "$("$script" stale foo 2>/dev/null)"

rm "$fixtures/fingerprint/$latest_foo"
assert_equal 'a newest commit with no pushed build is stale, so it is retried' \
  foo "$("$script" stale foo 2>/dev/null)"

content "$latest_foo" same
rm "$fixtures/fingerprint/$foo_old"
assert_equal 'a pin whose fingerprint cannot be read is stale' \
  foo "$("$script" stale foo 2>/dev/null)"

reset_fixtures
printf '%s\n%s\n' "$foo_old" "$foo_mid" >"$fixtures/pins/foo"
printf '%s\n' "$first" >"$fixtures/revision/$foo_mid"
content "$foo_old" same
content "$foo_mid" other
content "$latest_foo" same
assert_equal 'one main pin with other content names the image' \
  foo "$("$script" stale foo 2>/dev/null)"

# A delivery branch can outlive a pull request closed unmerged, so main and the
# branch both have to match.
reset_fixtures
printf '%s\n' "$foo_old" >"$fixtures/pins/foo"
printf '%s\n' "$foo_queued" >"$fixtures/queued/update-digests/foo"
printf '%s\n' "$first" >"$fixtures/revision/$foo_queued"
content "$foo_old" same
content "$foo_queued" other
content "$latest_foo" same
assert_equal 'a queued build with other content is stale although main matches' \
  foo "$("$script" stale foo 2>/dev/null)"

content "$foo_old" other
content "$foo_queued" same
assert_equal 'a queued build with the newest content is stale while main differs' \
  foo "$("$script" stale foo 2>/dev/null)"

content "$foo_old" same
assert_equal 'main and a queued build with the newest content are current' \
  '' "$("$script" stale foo 2>/dev/null)"

# A scheduled rebuild is tagged with main's head, not with $latest_foo.
reset_fixtures
printf '%s\n' "$foo_old" >"$fixtures/pins/foo"
content "$foo_old" same
content latest same
printf '%s\n' "$untouched" >"$fixtures/revision/latest"
assert_equal 'a latest build that contains the newest commit stands in for its missing tag' \
  '' "$("$script" stale foo 2>/dev/null)"

printf '%s\n' "$first" >"$fixtures/revision/latest"
assert_equal 'a latest build older than the newest commit does not count' \
  foo "$("$script" stale foo 2>/dev/null)"

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
