#!/usr/bin/env bash
# Covers the parts of continuous delivery that decide what gets written: which
# digest a manifest is pinning, what the rewrite touches and refuses, and when
# a run is too old to have anything to say. The registry read is the one piece
# left uncovered, because it is network and nothing else.

set -euo pipefail

script="$(cd "$(dirname "$0")" && pwd)/cd-digest-update.sh"
work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT

one='sha256:1111111111111111111111111111111111111111111111111111111111111111'
two='sha256:2222222222222222222222222222222222222222222222222222222222222222'
new='sha256:3333333333333333333333333333333333333333333333333333333333333333'

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

# A deployment that pins two sibling images, the shape mate and mate-sandbox
# share, where anchoring on the image name is the only thing keeping one build
# from stamping its digest onto the other.
siblings="$work/deployment.yaml"
cat >"$siblings" <<EOF
spec:
  containers:
    - name: mate
      image: ghcr.io/jonpulsifer/mate:latest@${one}
      env:
        - name: MATE_SANDBOX_IMAGE
          value: ghcr.io/jonpulsifer/mate-sandbox:latest@${two}
EOF

# A chart that splits repository from tag, so the digest sits on a line that
# never names the image.
split="$work/helm-release.yaml"
cat >"$split" <<EOF
spec:
  values:
    image:
      repository: ghcr.io/jonpulsifer/atlantis
      tag: latest@${one}
EOF

assert_equal 'pins reads the digest anchored on the image itself' \
  "$one" "$("$script" pins mate "$siblings")"

assert_equal 'pins is not confused by a sibling whose name starts the same' \
  "$two" "$("$script" pins mate-sandbox "$siblings")"

assert_equal 'pins reads a split repository/tag chart by its only digest' \
  "$one" "$("$script" pins atlantis "$split")"

assert_equal 'pins stays silent about a manifest that is not there' \
  '' "$("$script" pins mate "$work/absent.yaml")"

assert_equal 'pins reports each manifest once' \
  "$one" "$("$script" pins mate "$siblings" "$siblings")"

# --- rewrite ----------------------------------------------------------------

rewritten="$work/rewrite.yaml"
cp "$siblings" "$rewritten"
"$script" rewrite mate "$new" "$rewritten" >/dev/null
grep -qF "ghcr.io/jonpulsifer/mate:latest@${new}" "$rewritten" \
  || fail 'rewrite did not update the image it was given'
grep -qF "ghcr.io/jonpulsifer/mate-sandbox:latest@${two}" "$rewritten" \
  || fail 'rewrite stamped one image digest onto its sibling'

cp "$split" "$rewritten"
"$script" rewrite atlantis "$new" "$rewritten" >/dev/null
grep -qF "tag: latest@${new}" "$rewritten" \
  || fail 'rewrite did not reach a digest on a line that never names the image'

refuses() {
  local name="$1" image="$2" manifest="$3" output
  if output=$("$script" rewrite "$image" "$new" "$manifest" 2>&1); then
    printf 'FAIL: %s\noutput:\n%s\n' "$name" "$output" >&2
    exit 1
  fi
  case "$output" in
    *"::error::"*) ;;
    *) printf 'FAIL: %s refused without an annotated error\noutput:\n%s\n' "$name" "$output" >&2 && exit 1 ;;
  esac
}

refuses 'rewrite refuses a deploy target that does not exist' \
  mate "$work/absent.yaml"

cat >"$work/elsewhere.yaml" <<EOF
image: docker.io/jonpulsifer/mate:latest@${one}
EOF
refuses 'rewrite refuses an image pinned from a registry it does not publish to' \
  mate "$work/elsewhere.yaml"

cat >"$work/unpinned.yaml" <<'EOF'
image: ghcr.io/jonpulsifer/mate:latest
EOF
refuses 'rewrite refuses a manifest that pins no digest at all' \
  mate "$work/unpinned.yaml"

cat >"$work/ambiguous.yaml" <<EOF
image:
  repository: ghcr.io/jonpulsifer/atlantis
  tag: latest@${one}
sidecar:
  tag: latest@${two}
EOF
refuses 'rewrite refuses to guess between two digests it cannot anchor' \
  atlantis "$work/ambiguous.yaml"

# --- decide -----------------------------------------------------------------

repo="$work/repo"
git init -q -b main "$repo"
git -C "$repo" config user.email test@example.com
git -C "$repo" config user.name test
for n in 1 2 3; do
  echo "$n" >"$repo/file"
  git -C "$repo" add file
  git -C "$repo" commit -q -m "commit $n"
done
mapfile -t history < <(git -C "$repo" rev-list --reverse main)
first="${history[0]}"
middle="${history[1]}"
last="${history[2]}"

git -C "$repo" checkout -q -b aside "$first"
echo aside >"$repo/aside"
git -C "$repo" add aside
git -C "$repo" commit -q -m aside
diverged=$(git -C "$repo" rev-parse aside)
git -C "$repo" checkout -q main

decide() { (cd "$repo" && "$script" decide "$@" 2>/dev/null); }

assert_equal 'decide writes when nothing is pinned to compare against' \
  write "$(decide "$last")"

assert_equal 'decide writes when the manifest already pins this very commit' \
  write "$(decide "$middle" "$middle")"

assert_equal 'decide skips a run whose commit the pinned build already contains' \
  skip "$(decide "$first" "$last")"

assert_equal 'decide writes when this run is the newer of the two' \
  write "$(decide "$last" "$first")"

assert_equal 'decide skips on the one stale pin among several targets' \
  skip "$(decide "$first" "$first" "$last")"

assert_equal 'decide writes when the pinned build came from an unknown commit' \
  write "$(decide "$last" 0000000000000000000000000000000000000000)"

assert_equal 'decide writes when neither commit contains the other' \
  write "$(decide "$last" "$diverged")"

# A checkout with no history cannot answer the ancestry question honestly, and
# a guard that cannot answer must not be the thing that stops delivery.
shallow="$work/shallow"
git clone -q --depth=1 "file://$repo" "$shallow"
assert_equal 'decide writes rather than guess from a shallow checkout' \
  write "$( (cd "$shallow" && "$script" decide "$first" "$last" 2>/dev/null) )"

# --- usage ------------------------------------------------------------------

if (cd "$repo" && "$script" decide >/dev/null 2>&1); then
  fail 'decide accepted a call with no commit to judge'
fi
if "$script" nonsense >/dev/null 2>&1; then
  fail 'an unknown subcommand was accepted'
fi
