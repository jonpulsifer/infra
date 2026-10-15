#!/usr/bin/env bash
# Tests digest-only.sh against commits in a scratch repository whose
# .github/containers.json is a fixture.

set -euo pipefail

script="$(cd "$(dirname "$0")" && pwd)/digest-only.sh"
work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT

export GIT_CONFIG_GLOBAL="$work/gitconfig"
export GIT_CONFIG_SYSTEM=/dev/null
: >"$GIT_CONFIG_GLOBAL"

fail() {
  printf 'FAIL: %s\n' "$1" >&2
  exit 1
}

repo="$work/repo"
mkdir -p "$repo/.github" "$repo/deploy" "$repo/docs"
cd "$repo"
git init -q -b main .
git config user.name tester
git config user.email tester@example.invalid

cat >.github/containers.json <<'JSON'
{
  "build": ["mate", "kthx-engine", "atlantis"],
  "deploy": {
    "mate": ["deploy/mate.yaml"],
    "kthx-engine": ["deploy/release.yaml"],
    "atlantis": ["deploy/chart.yaml"]
  },
  "ignore": []
}
JSON

old='sha256:1111111111111111111111111111111111111111111111111111111111111111'
new='sha256:2222222222222222222222222222222222222222222222222222222222222222'

cat >deploy/mate.yaml <<YAML
spec:
  containers:
    - name: mate
      image: ghcr.io/jonpulsifer/mate:latest@$old
      env:
        - name: LOG_LEVEL
          value: info
YAML
cat >deploy/release.yaml <<YAML
values:
  engine:
    image: ghcr.io/jonpulsifer/kthx-engine:latest@$old
YAML
cat >deploy/chart.yaml <<YAML
values:
  image:
    repository: ghcr.io/jonpulsifer/atlantis
    tag: latest@$old
YAML
cat >deploy/other.yaml <<YAML
image: ghcr.io/jonpulsifer/mate:latest@$old
YAML
echo notes >docs/notes.md
git add -A
git commit -qm base
base=$(git rev-parse HEAD)

# Commits one change on top of base and prints the new commit.
change() {
  git checkout -q --detach "$base"
  "$@"
  git add -A
  git commit -qm change
  git rev-parse HEAD
}

expect() {
  local name="$1" want="$2" head="$3"
  shift 3
  local got=0
  "$script" "$base" "$head" "$@" || got=$?
  [[ "$got" == "$want" ]] || fail "$name: exit $got, want $want"
}

head=$(change sed -i "s/$old/$new/" deploy/mate.yaml)
expect 'a digest-only change to a deploy target skips' 0 "$head" deploy/mate.yaml

head=$(change sed -i "s/$old/$new/" deploy/release.yaml)
expect 'a digest-only change to a release skips' 0 "$head" deploy/release.yaml

head=$(change sed -i "s/$old/$new/" deploy/chart.yaml)
expect 'a digest-only change on a tag: line skips' 0 "$head" deploy/chart.yaml

head=$(change sed -i -e "s/$old/$new/" -e 's/value: info/value: debug/' deploy/mate.yaml)
expect 'a digest change beside another line runs' 1 "$head" deploy/mate.yaml

head=$(change sed -i "s/$old/$new/" deploy/other.yaml)
expect 'a digest-only change to a file that is not a deploy target runs' 1 "$head" deploy/other.yaml

head=$(change sed -i 's/notes/more notes/' docs/notes.md)
expect 'a docs change runs' 1 "$head" docs/notes.md

head=$(change sed -i '/image: /d' deploy/mate.yaml)
expect 'a deleted pin line runs' 1 "$head" deploy/mate.yaml

# Accepted: the pattern reads any first-party name, so a retarget to another
# first-party image counts as a digest move.
head=$(change sed -i "s|jonpulsifer/mate:latest@$old|jonpulsifer/mate-voice:latest@$new|" deploy/mate.yaml)
expect 'a pin swapped to another first-party image skips' 0 "$head" deploy/mate.yaml

echo 'digest-only: all assertions passed'
