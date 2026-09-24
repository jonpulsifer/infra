#!/usr/bin/env bash
# Tests cd-digest-update.sh without the network. cd-digest-step_test.sh covers
# the workflow step and the registry read.

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

# Two sibling images in one manifest: only the name anchor keeps one build's
# digest off the other.
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

# Several branches end in `write`, so the ones that refuse to guess are
# asserted on their stderr reason.
decide_reason() { (cd "$1" && "$script" decide "${@:2}" >/dev/null) 2>&1; }

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

assert_equal 'decide says the pinned build came from a commit it does not have' \
  'Cannot compare: the pinned image was built from 0000000000000000000000000000000000000000, which is not a commit in this checkout.' \
  "$(decide_reason "$repo" "$last" 0000000000000000000000000000000000000000)"

assert_equal 'decide writes when its own commit is not in the checkout' \
  write "$(decide 0000000000000000000000000000000000000000 "$last")"

assert_equal 'decide says when its own commit is not in the checkout' \
  'Cannot compare: 0000000000000000000000000000000000000000 is not a commit in this checkout.' \
  "$(decide_reason "$repo" 0000000000000000000000000000000000000000 "$last")"

shallow="$work/shallow"
git clone -q --depth=1 "file://$repo" "$shallow"
assert_equal 'decide writes rather than guess from a shallow checkout' \
  write "$( (cd "$shallow" && "$script" decide "$first" "$last" 2>/dev/null) )"

# Depth 1 fails the missing-commit check first. Depth 2 holds both commits, so
# only the shallow check stops merge-base from answering.
shallow2="$work/shallow2"
git clone -q --depth=2 "file://$repo" "$shallow2"
assert_equal 'a two-deep clone really is shallow and really holds both commits' \
  'true' "$(git -C "$shallow2" rev-parse --is-shallow-repository)"
assert_equal 'decide writes rather than trust a truncated history that answers' \
  write "$( (cd "$shallow2" && "$script" decide "$middle" "$last" 2>/dev/null) )"
assert_equal 'decide says it will not read ancestry out of a truncated history' \
  "Cannot compare $middle with the pinned build's $last: this checkout carries no commit history." \
  "$(decide_reason "$shallow2" "$middle" "$last")"

queued="$work/queued"
git init -q -b main "$queued"
git -C "$queued" config user.email test@example.com
git -C "$queued" config user.name test
mkdir -p "$queued/clusters/app"
queued_manifest=clusters/app/deployment.yaml
printf 'image: ghcr.io/jonpulsifer/mate:latest@%s\n' "$one" >"$queued/$queued_manifest"
git -C "$queued" add -A
git -C "$queued" commit -q -m 'pin the first build'
git -C "$queued" checkout -q -b cd/update-mate-digest
printf 'image: ghcr.io/jonpulsifer/mate:latest@%s\n' "$two" >"$queued/$queued_manifest"
git -C "$queued" commit -q -am 'queue a newer build'
git -C "$queued" checkout -q main

pins_at() { (cd "$queued" && "$script" pins-at "$@"); }

assert_equal 'pins-at reads the branch, not the working tree beside it' \
  "$two" "$(pins_at cd/update-mate-digest mate "$queued_manifest")"

assert_equal 'pins reads the working tree, not the branch' \
  "$one" "$( (cd "$queued" && "$script" pins mate "$queued_manifest") )"

assert_equal 'pins-at is silent about a branch that does not exist yet' \
  '' "$(pins_at refs/cd/queued/nothing-here mate "$queued_manifest")"

assert_equal 'pins-at is silent about a file that ref does not carry' \
  '' "$(pins_at cd/update-mate-digest mate clusters/app/absent.yaml)"

assert_equal 'pins-at leaves nothing behind in the working tree' \
  '' "$(git -C "$queued" status --porcelain)"

if (cd "$repo" && "$script" decide >/dev/null 2>&1); then
  fail 'decide accepted a call with no commit to judge'
fi
if "$script" nonsense >/dev/null 2>&1; then
  fail 'an unknown subcommand was accepted'
fi
