#!/usr/bin/env bash
# Runs the continuous-delivery digest step end to end against a local remote.
#
# `cd-digest-update_test.sh` covers what the script decides. This covers what
# the step *asks* it, which is where the interesting failure was: the guard was
# correct and the step handed it half its inputs, so an older run still won. A
# unit test cannot see that — only running the step can — so the step body is
# read out of the workflow with `yq` rather than copied here, and this test
# fails the moment the two disagree.
#
# Nothing here reaches the network. The git remote is a bare repository on
# disk, reached through an `insteadOf` rewrite of the github.com URL the step
# pushes to, and `gh` and `curl` are stubs on PATH. The curl stub speaks enough
# of the registry API to exercise the real `revision` read — index, platform
# manifest, config blob, label — because that read is what the guard believes.

set -euo pipefail

here="$(cd "$(dirname "$0")" && pwd)"
workflow="$here/../workflows/containers.yml"
step_name='Update manifest digest for selective continuous delivery'

work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT

# Isolated so the test cannot read — or write — the developer's git config, and
# so the URL rewrite below is scoped to this run.
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

# --- the step, read out of the workflow -------------------------------------

step="$work/step.sh"
export STEP_NAME="$step_name"
yq -r '.jobs.build.steps[] | select(.name == strenv(STEP_NAME)) | .run' "$workflow" >"$step"
[ -s "$step" ] || fail "no step named '$step_name' in $workflow"

# The step's environment is declared in YAML and supplied here by hand, so a
# new variable added there without being set here would silently run the step
# with it unset. Comparing the two lists makes that a failed test instead.
# `GITHUB_REPOSITORY`, `RUNNER_TEMP` and the rest come from the runner, not
# from the step, so they are not in this list.
declared=$(yq -r '.jobs.build.steps[] | select(.name == strenv(STEP_NAME)) | .env | keys | sort | .[]' "$workflow")
assert_equal 'the step declares exactly the environment this test supplies' \
  $'BUILT_COMMIT\nCD_ACTOR\nDIGEST\nGH_TOKEN\nIMAGE_NAME\nMANIFESTS\nREGISTRY_REPOSITORY' \
  "$declared"

# --- stubs ------------------------------------------------------------------

stubs="$work/stubs"
mkdir -p "$stubs"

# Every `gh` call the step makes, recorded so the assertions can read them.
# `pr list` answers with nothing, which is the step's "no pull request open
# yet" branch.
cat >"$stubs/gh" <<'STUB'
#!/usr/bin/env bash
printf '%s\n' "$*" >>"$GH_LOG"
case "$*" in
  "pr list"*) ;;
  *) ;;
esac
exit 0
STUB

# The registry, as far as `revision` is concerned. The fixture file maps a
# digest to the commit its build came from; a digest that is not in it answers
# 404, which is what an unreadable pin looks like.
cat >"$stubs/curl" <<'STUB'
#!/usr/bin/env bash
url="${!#}"
digest_for() { printf '%s' "${1##*/}"; }
case "$url" in
  https://ghcr.io/token\?*)
    printf '{"token":"stub"}'
    ;;
  *"/blobs/"*)
    d=$(digest_for "$url"); d="${d%.config}"
    commit=$(awk -v d="$d" '$1 == d { print $2 }' "$REGISTRY_FIXTURE")
    [ -n "$commit" ] || exit 22
    printf '{"config":{"Labels":{"org.opencontainers.image.revision":"%s"}}}' "$commit"
    ;;
  *"/manifests/"*.amd64)
    d=$(digest_for "$url")
    printf '{"config":{"digest":"%s.config"}}' "${d%.amd64}"
    ;;
  *"/manifests/"*)
    d=$(digest_for "$url")
    grep -q "^$d " "$REGISTRY_FIXTURE" || exit 22
    # The shape buildx pushes with `provenance:` and `sbom:` on: the real
    # platform image beside an unknown/unknown attestation manifest.
    printf '{"manifests":[{"digest":"%s.att","platform":{"os":"unknown","architecture":"unknown"}},{"digest":"%s.amd64","platform":{"os":"linux","architecture":"amd64"}}]}' "$d" "$d"
    ;;
  *) exit 22 ;;
esac
STUB
chmod +x "$stubs/gh" "$stubs/curl"
export PATH="$stubs:$PATH"

export REGISTRY_FIXTURE="$work/registry"
: >"$REGISTRY_FIXTURE"
publish() { printf '%s %s\n' "$1" "$2" >>"$REGISTRY_FIXTURE"; }

# --- the repository ---------------------------------------------------------

manifest=clusters/offsite/apps/mate/deployment.yaml
remote="$work/remote.git"
git init -q --bare -b main "$remote"
# So a checkout can ask for one commit by sha, the way actions/checkout does.
git -C "$remote" config uploadpack.allowAnySHA1InWant true

seed="$work/seed"
git init -q -b main "$seed"
git -C "$seed" config user.email cd@example.com
git -C "$seed" config user.name cd
mkdir -p "$seed/$(dirname "$manifest")" "$seed/.github/scripts"
cp "$here/cd-digest-update.sh" "$seed/.github/scripts/cd-digest-update.sh"
jq -n --arg m "$manifest" '{deploy: {mate: [$m]}}' >"$seed/.github/containers.json"

digest() {
  local c="$1" body="" i
  for ((i = 0; i < 64; i++)); do body+="$c"; done
  printf 'sha256:%s' "$body"
}
d0=$(digest 0)
d1=$(digest 1)
d2=$(digest 2)

pin() {
  printf 'spec:\n  containers:\n    - name: mate\n      image: ghcr.io/jonpulsifer/mate:latest@%s\n' \
    "$1" >"$seed/$manifest"
}

commit() {
  git -C "$seed" add -A
  git -C "$seed" commit -q -m "$1"
  git -C "$seed" rev-parse HEAD
}

pin "$d0"
c0=$(commit 'pin the first build')
echo one >"$seed/unrelated"
c1=$(commit 'a commit whose build was cancelled')
echo two >"$seed/unrelated"
c2=$(commit 'a later commit')
git -C "$seed" remote add origin "$remote"
git -C "$seed" push -q origin main

publish "$d0" "$c0"
publish "$d1" "$c1"
publish "$d2" "$c2"

export GH_LOG="$work/gh.log"
: >"$GH_LOG"

token=stub-token
repository=jonpulsifer/infra
git config --global \
  "url.file://$remote.insteadOf" "https://x-access-token:$token@github.com/$repository.git"

# Runs the step the way the job does: a depth-1 checkout of the built commit,
# the matrix values in the environment, everything else left to the step.
run_step() {
  local built="$1" built_digest="$2" image="${3:-mate}" manifests="${4:-}"
  local wt="$work/run"
  rm -rf "$wt"
  git init -q "$wt"
  git -C "$wt" remote add origin "$remote"
  git -C "$wt" fetch -q --depth=1 origin "$built"
  git -C "$wt" checkout -q FETCH_HEAD
  if [ -z "$manifests" ]; then
    manifests=$(jq -c --arg img "$image" '.deploy[$img] // []' "$wt/.github/containers.json")
  fi
  (
    cd "$wt"
    RUNNER_TEMP=$(mktemp -d -p "$work") \
    GITHUB_REPOSITORY="$repository" \
    IMAGE_NAME="$image" \
    DIGEST="$built_digest" \
    MANIFESTS="$manifests" \
    GH_TOKEN="$token" \
    CD_ACTOR="" \
    BUILT_COMMIT="$built" \
    REGISTRY_REPOSITORY="jonpulsifer/$image" \
      bash "$step"
  )
}

branch=cd/update-mate-digest
queued_digest() {
  git -C "$remote" show "$branch:$manifest" 2>/dev/null | grep -oE 'sha256:[0-9a-f]{64}' || true
}

# --- the regression this guard exists for -----------------------------------
#
# `main` still pins the first build, because neither digest pull request has
# merged. The newer commit's run lands first; then the older commit's run is
# re-run, which is the documented recovery for a run cancelled before its jobs
# started. Reading only what `main` pins, the older run sees a first-build
# commit it is not an ancestor of, writes, and its force-push replaces the
# newer digest on the shared branch — so the open pull request goes on to merge
# the older build.

run_step "$c2" "$d2" >"$work/log.c2" 2>&1 || fail "the newer run failed: $(cat "$work/log.c2")"
assert_equal 'the newer run queues its digest' "$d2" "$(queued_digest)"

run_step "$c1" "$d1" >"$work/log.c1" 2>&1 || fail "the rerun failed: $(cat "$work/log.c1")"
assert_equal 'a rerun of an older commit does not clobber a newer digest already queued' \
  "$d2" "$(queued_digest)"
grep -q '::notice::' "$work/log.c1" \
  || fail 'the rerun skipped without saying so'

# The other order: nothing queued, then the newer build arrives and must win.
git -C "$remote" update-ref -d "refs/heads/$branch"
run_step "$c1" "$d1" >"$work/log.c1b" 2>&1 || fail "the first run failed: $(cat "$work/log.c1b")"
assert_equal 'the first run queues its digest' "$d1" "$(queued_digest)"
run_step "$c2" "$d2" >"$work/log.c2b" 2>&1 || fail "the newer run failed: $(cat "$work/log.c2b")"
assert_equal 'a newer build replaces an older digest already queued' "$d2" "$(queued_digest)"

# --- the pull request is a one-line change against current main -------------

assert_equal 'the delivery branch sits directly on current main' \
  "$(git -C "$remote" rev-parse main)" "$(git -C "$remote" rev-parse "$branch^")"
assert_equal 'the delivery branch changes exactly the deploy target' \
  "$manifest" "$(git -C "$remote" diff --name-only "main..$branch")"

# --- a pin whose provenance cannot be read is still overwritten -------------
#
# Skip only on proof: an unreadable queued digest is a digest nobody recorded
# the provenance of, and refusing to write over it would wedge this image's
# delivery with no recovery but editing the branch by hand.

unknown=$(digest 9)
git -C "$remote" update-ref -d "refs/heads/$branch"
queue="$work/queue"
git clone -q "$remote" "$queue"
git -C "$queue" config user.email cd@example.com
git -C "$queue" config user.name cd
git -C "$queue" checkout -q -b "$branch"
sed -i -E "s|@sha256:[0-9a-f]{64}|@${unknown}|" "$queue/$manifest"
git -C "$queue" commit -q -am 'a queued digest the registry does not know'
git -C "$queue" push -q origin "$branch"
run_step "$c1" "$d1" >"$work/log.unknown" 2>&1 || fail "the run failed: $(cat "$work/log.unknown")"
assert_equal 'a queued digest with no readable provenance does not block delivery' \
  "$d1" "$(queued_digest)"
grep -q '::warning::Cannot tell which commit' "$work/log.unknown" \
  || fail 'the unreadable pin was passed over without a warning'

# --- main moved the deploy target since this commit was built ---------------
#
# The step rewrites main's copy of the manifest, so the file it must edit is
# the one main names today. Taking the target list from the built commit names
# a path main no longer has, and the step fails — every time, for every rerun.

git -C "$remote" update-ref -d "refs/heads/$branch"
renamed=clusters/offsite/apps/mate/workload.yaml
git -C "$seed" mv "$manifest" "$renamed"
jq --arg m "$renamed" '.deploy.mate = [$m]' "$seed/.github/containers.json" >"$work/map"
mv "$work/map" "$seed/.github/containers.json"
git -C "$seed" add -A
git -C "$seed" commit -q -m 'move the deployment manifest'
git -C "$seed" push -q origin main

# Deliberately the *old* target list, which is what the matrix of a run built
# before the rename carries.
run_step "$c2" "$d2" mate "[\"$manifest\"]" >"$work/log.renamed" 2>&1 \
  || fail "a target renamed on main failed the step: $(cat "$work/log.renamed")"
assert_equal 'a target renamed on main since the build is followed, not refused' \
  "$d2" "$(git -C "$remote" show "$branch:$renamed" | grep -oE 'sha256:[0-9a-f]{64}')"

# --- main dropped the image from its deploy map -----------------------------

jq 'del(.deploy.mate)' "$seed/.github/containers.json" >"$work/map"
mv "$work/map" "$seed/.github/containers.json"
git -C "$seed" add -A
git -C "$seed" commit -q -m 'stop deploying mate from this repo'
git -C "$seed" push -q origin main
run_step "$c2" "$d2" mate "[\"$renamed\"]" >"$work/log.dropped" 2>&1 \
  || fail "an image main no longer deploys failed the step: $(cat "$work/log.dropped")"
grep -q 'no longer lists\|lists none' "$work/log.dropped" \
  || fail 'the step did not say why it had nothing to roll'

printf 'ok: the continuous-delivery step holds its ground against an older rerun\n'
