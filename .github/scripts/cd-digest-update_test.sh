#!/usr/bin/env bash
# Tests cd-digest-update.sh without the network: a curl stub answers the
# registry reads. cd-digest-step_test.sh covers the workflow step.

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

# The registry is a directory of canned answers behind a curl stub, which logs
# each URL so the test can name every call `fingerprint` makes.
registry="$work/registry"
mkdir -p "$registry/manifests" "$registry/blobs" "$work/bin"
cat >"$work/bin/curl" <<'STUB'
#!/usr/bin/env bash
url="${!#}"
printf '%s\n' "$url" >>"$REGISTRY/calls"
case "$url" in
  https://ghcr.io/token\?*)
    [ ! -e "$REGISTRY/no-token" ] || exit 22
    printf '{"token":"stub"}'
    ;;
  https://ghcr.io/v2/jonpulsifer/app/manifests/*) cat "$REGISTRY/manifests/${url##*/}" 2>/dev/null || exit 22 ;;
  https://ghcr.io/v2/jonpulsifer/app/blobs/*) cat "$REGISTRY/blobs/${url##*/}" 2>/dev/null || exit 22 ;;
  *) exit 22 ;;
esac
STUB
chmod +x "$work/bin/curl"
export REGISTRY="$registry"
export PATH="$work/bin:$PATH"

# Publishes <ref> as buildx pushes it: an index of one image per platform beside
# an attestation manifest. Each platform is `os/arch=config-json`, in order.
publish() {
  local ref="$1" entry platform config children='[]'
  shift
  for entry in "$@"; do
    platform="${entry%%=*}"
    config="${entry#*=}"
    printf '%s' "$config" >"$registry/blobs/$ref.${platform//\//-}.config"
    printf '{"config":{"digest":"%s"}}' "$ref.${platform//\//-}.config" >"$registry/manifests/$ref.${platform//\//-}"
    children=$(jq -c --arg d "$ref.${platform//\//-}" --arg os "${platform%/*}" --arg arch "${platform#*/}" \
      '. + [{digest: $d, platform: {os: $os, architecture: $arch}}]' <<<"$children")
  done
  jq -c --arg att "$ref.att" '{manifests: (. + [{digest: $att, platform: {os: "unknown", architecture: "unknown"}}])}' \
    <<<"$children" >"$registry/manifests/$ref"
}

image_config() {
  local revision="$1" created="$2" env="$3" layers="$4"
  jq -cn --arg r "$revision" --arg c "$created" --arg e "$env" --arg l "$layers" \
    '{architecture: "amd64", created: $c, history: [{created: $c}],
      config: {Cmd: ["bun", "start"], Env: [$e], Labels: {"org.opencontainers.image.revision": $r, "org.opencontainers.image.created": $c}},
      rootfs: {type: "layers", diff_ids: ($l | split(" "))}}'
}

fingerprint() { "$script" fingerprint jonpulsifer/app "$1"; }

base=$(image_config aaa 2026-10-01T00:00:00Z PATH=/usr/bin 'sha256:l1 sha256:l2')
publish built-once "linux/amd64=$base"
publish built-again "linux/amd64=$(image_config bbb 2026-10-02T00:00:00Z PATH=/usr/bin 'sha256:l1 sha256:l2')"
publish new-layer "linux/amd64=$(image_config aaa 2026-10-01T00:00:00Z PATH=/usr/bin 'sha256:l1 sha256:l3')"
publish new-env "linux/amd64=$(image_config aaa 2026-10-01T00:00:00Z PATH=/bin 'sha256:l1 sha256:l2')"
publish arm-first "linux/arm64=$(image_config aaa 2026-10-01T00:00:00Z PATH=/usr/bin 'sha256:a1')" "linux/amd64=$base"
publish arm-only "linux/arm64=$base"
publish no-layers "linux/amd64=$(image_config aaa 2026-10-01T00:00:00Z PATH=/usr/bin '' | jq -c '.rootfs.diff_ids = []')"
publish 0123456789abcdef0123456789abcdef01234567 "linux/amd64=$base"

once=$(fingerprint built-once)
[[ "$once" =~ ^[0-9a-f]{64}$ ]] || fail "fingerprint printed '$once', not one sha256"

: >"$registry/calls"
fingerprint built-once >/dev/null
assert_equal 'fingerprint reads the index, the amd64 manifest and its config, and never a layer' \
  "https://ghcr.io/token?scope=repository:jonpulsifer/app:pull&service=ghcr.io
https://ghcr.io/v2/jonpulsifer/app/manifests/built-once
https://ghcr.io/v2/jonpulsifer/app/manifests/built-once.linux-amd64
https://ghcr.io/v2/jonpulsifer/app/blobs/built-once.linux-amd64.config" \
  "$(cat "$registry/calls")"

assert_equal 'fingerprint ignores the labels and creation times every build changes' \
  "$once" "$(fingerprint built-again)"

[ "$(fingerprint new-layer)" != "$once" ] \
  || fail 'fingerprint missed a changed layer'
[ "$(fingerprint new-env)" != "$once" ] \
  || fail 'fingerprint missed a changed runtime config'

assert_equal 'fingerprint reads the amd64 image although another platform comes first' \
  "$once" "$(fingerprint arm-first)"

assert_equal 'fingerprint reads a commit tag as it reads a digest' \
  "$once" "$(fingerprint 0123456789abcdef0123456789abcdef01234567)"

assert_equal 'revision still reads the first platform image after the shared fetch' \
  aaa "$("$script" revision jonpulsifer/app arm-first)"

# Every failure is silent and exits 0, so the caller opens the pull request.
# The last case is a registry that issues no token.
for ref in arm-only no-layers absent built-once; do
  [ "$ref" != built-once ] || touch "$registry/no-token"
  out=$(fingerprint "$ref") || fail "fingerprint of $ref failed instead of printing nothing"
  assert_equal "fingerprint prints nothing for $ref" '' "$out"
done
rm "$registry/no-token"

if (cd "$repo" && "$script" decide >/dev/null 2>&1); then
  fail 'decide accepted a call with no commit to judge'
fi
if "$script" nonsense >/dev/null 2>&1; then
  fail 'an unknown subcommand was accepted'
fi
