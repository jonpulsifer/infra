#!/usr/bin/env bash
# Tests detect-containers.sh against a commit graph on disk. Each case runs in
# a depth-1 clone of its head, the way the detect job checks out, and the
# fixture carries the real containers.yml so the build-shape read sees the
# workflow that ships.

set -euo pipefail

here="$(cd "$(dirname "$0")" && pwd)"
script="$here/detect-containers.sh"
workflow="$here/../workflows/containers.yml"

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

remote="$work/remote.git"
git init -q --bare -b main "$remote"
# So a shallow clone can fetch its base by sha, as it can from GitHub.
git -C "$remote" config uploadpack.allowAnySHA1InWant true

seed="$work/seed"
git init -q -b main "$seed"
git -C "$seed" config user.email detect@example.com
git -C "$seed" config user.name detect
git -C "$seed" remote add origin "$remote"

mkdir -p "$seed/.github/workflows" "$seed/.github/scripts" \
  "$seed/apps/foo" "$seed/apps/bar" "$seed/images/baz" "$seed/shared"
cp "$workflow" "$seed/.github/workflows/containers.yml"
cp "$script" "$seed/.github/scripts/detect-containers.sh"
cat >"$seed/.github/containers.json" <<'JSON'
{
  "build": ["foo", "bar"],
  "deploy": {
    "foo": ["clusters/foo.yaml"],
    "bar": ["clusters/bar.yaml"]
  },
  "ignore": ["baz"]
}
JSON
echo 'FROM scratch' >"$seed/apps/foo/Dockerfile"
echo 'FROM scratch' >"$seed/apps/bar/Dockerfile"
echo '[{"watch": ["apps/bar", "shared"]}]' >"$seed/apps/bar/build.json"
echo 'FROM scratch' >"$seed/images/baz/Dockerfile"
echo one >"$seed/shared/lib.ts"
git -C "$seed" add -A
git -C "$seed" commit -q -m seed
git -C "$seed" push -q origin main
base=$(git -C "$seed" rev-parse HEAD)

# Starts a case's head from the base commit.
from_base() { git -C "$seed" checkout -q -B head "$base"; }

edit_workflow() { yq -i "$1" "$seed/.github/workflows/containers.yml"; }

edit_manifest() {
  jq "$1" "$seed/.github/containers.json" >"$work/manifest"
  mv "$work/manifest" "$seed/.github/containers.json"
}

# Commits the head, then prints the images detect builds for it, sorted and
# space separated. The changed files are tj-actions' list, with the trailing
# backslash its safe_output leaves on all but the last.
detect() {
  local event="$1" base_sha="$2" wt="$work/run" changed out
  git -C "$seed" add -A
  git -C "$seed" diff --cached --quiet || git -C "$seed" commit -q -m case
  git -C "$seed" push -q -f origin head 2>/dev/null
  changed=$(git -C "$seed" diff --name-only "$base" HEAD | sed '$!s/$/\\/')
  rm -rf "$wt"
  git clone -q --depth=1 --branch head "file://$remote" "$wt" || return 1
  out="$work/output"
  : >"$out"
  # Checked by hand, because errexit does not reach a command substitution or
  # an `if` condition, and an empty answer is a case's expected output.
  (
    cd "$wt"
    EVENT_NAME="$event" BASE_SHA="$base_sha" CHANGED_FILES="$changed" \
      GITHUB_OUTPUT="$out" bash .github/scripts/detect-containers.sh
  ) || return 1
  grep -q '^has_changes=' "$out" || return 1
  sed -n 's/^matrix=//p' "$out" | jq -r '.include[].image' | sort | paste -sd' ' -
}

from_base
edit_workflow '(.jobs.build.steps[] | select(.name == "Mint a continuous-delivery App token") | .with."app-id") = "another-app"'
assert_equal 'a pull request that changes the workflow builds every image' \
  'bar foo' "$(detect pull_request "$base")"
assert_equal 'a push that changes only the token step builds nothing' \
  '' "$(detect push "$base")"

from_base
edit_workflow '.jobs.cd-guard.steps += [{"run": "true"}] | .on.push.branches += ["next"]'
echo '# a comment' >>"$seed/.github/scripts/detect-containers.sh"
assert_equal 'a push that changes cd-guard, the triggers and this script builds nothing' \
  '' "$(detect push "$base")"

from_base
edit_workflow '.jobs.build.steps += [{"name": "Scan the pushed image", "run": "true"}]'
assert_equal 'a push that adds a scan of the pushed image builds nothing' \
  '' "$(detect push "$base")"

from_base
edit_workflow '(.jobs.build.steps[] | select(.id == "push") | .with.sbom) = false'
assert_equal 'a push that changes a build-push-action input builds every image' \
  'bar foo' "$(detect push "$base")"

from_base
edit_manifest '.deploy.bar = ["clusters/bar-moved.yaml"]'
assert_equal 'a push that retargets one image builds that image only' \
  bar "$(detect push "$base")"

from_base
git -C "$seed" mv apps/foo apps/qux
edit_manifest '.build = ["qux", "bar"] | .deploy = {qux: .deploy.foo, bar: .deploy.bar}'
assert_equal 'a push that renames an image builds only the new name' \
  qux "$(detect push "$base")"

from_base
edit_manifest '.deploy.bar = ["clusters/bar-moved.yaml"]'
assert_equal 'a push with no base builds every image' \
  'bar foo' "$(detect push '')"
assert_equal 'a push with an all-zero base builds every image' \
  'bar foo' "$(detect push 0000000000000000000000000000000000000000)"
assert_equal 'a push whose base cannot be fetched builds every image' \
  'bar foo' "$(detect push 1234567890abcdef1234567890abcdef12345678)"

from_base
echo two >>"$seed/shared/lib.ts"
assert_equal 'a push that changes a watch path builds the image that watches it' \
  bar "$(detect push "$base")"
assert_equal 'a pull request that changes a watch path builds the image that watches it' \
  bar "$(detect pull_request "$base")"

from_base
mkdir -p "$seed/apps/stray"
echo 'FROM scratch' >"$seed/apps/stray/Dockerfile"
if detect push "$base" >/dev/null 2>"$work/stderr"; then
  fail 'an unclassified Dockerfile passed detection'
fi
grep -q 'stray' "$work/stderr" || fail "the failure did not name the image: $(cat "$work/stderr")"

from_base
assert_equal '--watches lists every watch of every build image' \
  $'bar\tapps/bar\nbar\tshared\nfoo\tapps/foo' \
  "$(cd "$seed" && bash .github/scripts/detect-containers.sh --watches | sort)"

printf 'ok: detect-containers builds what a change touches and fails open\n'
