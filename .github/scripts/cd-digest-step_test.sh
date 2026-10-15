#!/usr/bin/env bash
# Runs the containers.yml delivery end to end: each build leg's record step,
# then the deliver job's step, both read out of the workflow with yq. The
# remote is a bare repository on disk, and `gh` and `curl` are stubs.

set -euo pipefail

here="$(cd "$(dirname "$0")" && pwd)"
workflow="$here/../workflows/containers.yml"
record_name='Record the build for delivery'
deliver_name='Update manifest digests for selective continuous delivery'

work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT

# Keeps the developer's git config out, and the URL rewrite below in this run.
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

# Prints one key of a named step in a job.
step_field() {
  JOB="$1" STEP="$2" yq -r ".jobs[strenv(JOB)].steps[] | select(.name == strenv(STEP)) | $3" "$workflow"
}

record="$work/record.sh"
deliver="$work/deliver.sh"
step_field build "$record_name" .run >"$record"
step_field deliver "$deliver_name" .run >"$deliver"
[ -s "$record" ] || fail "no build step named '$record_name' in $workflow"
[ -s "$deliver" ] || fail "no deliver step named '$deliver_name' in $workflow"

# The runs below supply each step's env by hand, so a variable added to the
# YAML fails here instead of running unset. Runner variables are not listed.
assert_equal 'the record step declares exactly the environment this test supplies' \
  $'BUILT_COMMIT\nDIGEST\nIMAGE_NAME\nMANIFESTS' \
  "$(step_field build "$record_name" '.env | keys | sort | .[]')"
assert_equal 'the deliver step declares exactly the environment this test supplies' \
  $'CD_ACTOR\nGH_TOKEN\nREGISTRY_OWNER' \
  "$(step_field deliver "$deliver_name" '.env | keys | sort | .[]')"

# A persisted checkout header outranks the token in the push URL, and a push as
# github-actions[bot] to an open pull request never runs its checks.
assert_equal 'the deliver checkout persists no token for the delivery push to use' \
  false "$(step_field deliver Checkout '.with."persist-credentials"')"

# The artifact the build uploads is the one deliver downloads.
assert_equal 'each leg uploads its record under a name the deliver job downloads' \
  "cd-\${{ matrix.image }} cd-*" \
  "$(step_field build 'Record the build as an artifact' .with.name) $(step_field deliver 'Download the build records' .with.pattern)"

stubs="$work/stubs"
mkdir -p "$stubs"

# Logs every call and keeps the open pull requests in $GH_STATE, one file per
# head branch holding its number. Closing with --delete-branch deletes the
# branch on the remote, as GitHub does.
cat >"$stubs/gh" <<'STUB'
#!/usr/bin/env bash
set -euo pipefail
printf '%s\n' "$*" >>"$GH_LOG"
head=""
args=("$@")
for ((i = 0; i < ${#args[@]}; i++)); do
  [ "${args[i]}" != --head ] || head="${args[i + 1]}"
done
open="$GH_STATE/open"
case "$1 $2" in
  "pr list")
    [ ! -f "$open/${head//\//_}" ] || cat "$open/${head//\//_}"
    ;;
  "pr create")
    n=$(cat "$GH_STATE/next")
    echo $((n + 1)) >"$GH_STATE/next"
    echo "$n" >"$open/${head//\//_}"
    echo "https://github.com/jonpulsifer/infra/pull/$n"
    ;;
  "pr close")
    for f in "$open"/*; do
      [ "$(cat "$f")" = "$3" ] || continue
      rm -f "$f"
      branch="${f##*/}"
      if [[ " $* " == *" --delete-branch "* ]]; then
        git --git-dir="$REMOTE" update-ref -d "refs/heads/${branch//_//}"
      fi
    done
    ;;
esac
STUB

# The fixture maps a digest to its build commit and to the layer its image
# holds, which defaults to one of its own. An unknown digest fails as an HTTP
# error, which is how an unreadable pin looks, and a layer named `unreadable`
# fails the config read the same way.
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
    read -r commit layer < <(awk -v d="$d" '$1 == d { print $2, $3 }' "$REGISTRY_FIXTURE")
    [ -n "$commit" ] || exit 22
    [ "$layer" != unreadable ] || exit 22
    printf '{"rootfs":{"type":"layers","diff_ids":["%s"]},"config":{"Cmd":["bun","start"],"Labels":{"org.opencontainers.image.revision":"%s"}}}' \
      "${layer:-$d}" "$commit"
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
publish() { printf '%s %s %s\n' "$1" "$2" "${3:-}" >>"$REGISTRY_FIXTURE"; }

remote="$work/remote.git"
export REMOTE="$remote"
git init -q --bare -b main "$remote"
# So a checkout can ask for one commit by sha, the way actions/checkout does.
git -C "$remote" config uploadpack.allowAnySHA1InWant true

seed="$work/seed"
git init -q -b main "$seed"
git -C "$seed" config user.email cd@example.com
git -C "$seed" config user.name cd
mkdir -p "$seed/.github/scripts"
cp "$here/cd-digest-update.sh" "$seed/.github/scripts/cd-digest-update.sh"

declare -A manifest=(
  [hub]=clusters/folly/apps/hub/deployment.yaml
  [mate]=clusters/offsite/apps/mate/deployment.yaml
  [weather]=clusters/folly/apps/weather/deployment.yaml
)
jq -n --arg hub "${manifest[hub]}" --arg mate "${manifest[mate]}" --arg weather "${manifest[weather]}" \
  '{deploy: {hub: [$hub], mate: [$mate], weather: [$weather]}}' >"$seed/.github/containers.json"

digest() { printf 'sha256:%s' "$(printf '%s' "$1" | sha256sum | cut -c1-64)"; }

pin() {
  local image="$1" file="$seed/${manifest[$1]}"
  mkdir -p "$(dirname "$file")"
  printf 'spec:\n  containers:\n    - name: %s\n      image: ghcr.io/jonpulsifer/%s:latest@%s\n' \
    "$image" "$image" "$2" >"$file"
}

commit() {
  git -C "$seed" add -A
  git -C "$seed" commit -q -m "$1"
  git -C "$seed" rev-parse HEAD
}

for image in hub mate weather; do pin "$image" "$(digest "$image-0")"; done
c0=$(commit 'pin the first builds')
echo one >"$seed/unrelated"
c1=$(commit 'a commit whose build was cancelled')
echo two >"$seed/unrelated"
c2=$(commit 'a later commit')
git -C "$seed" remote add origin "$remote"
git -C "$seed" push -q origin main

for image in hub mate weather; do
  publish "$(digest "$image-0")" "$c0"
  publish "$(digest "$image-1")" "$c1"
  publish "$(digest "$image-2")" "$c2"
done

export GH_LOG="$work/gh.log" GH_STATE="$work/gh"
mkdir -p "$GH_STATE/open"
echo 100 >"$GH_STATE/next"
: >"$GH_LOG"

token=stub-token
repository=jonpulsifer/infra
git config --global \
  "url.file://$remote.insteadOf" "https://x-access-token:$token@github.com/$repository.git"

# Like a run: a depth-1 checkout of the built commit, one record step per
# `image=digest` argument with its matrix values, then the deliver step. A
# third field after a second `=` overrides the matrix's manifest list.
run() {
  local built="$1" wt="$work/run" temp spec image rest built_digest manifests
  shift
  rm -rf "$wt"
  git init -q "$wt"
  git -C "$wt" remote add origin "$remote"
  git -C "$wt" fetch -q --depth=1 origin "$built"
  git -C "$wt" checkout -q FETCH_HEAD
  temp=$(mktemp -d -p "$work")
  for spec in "$@"; do
    image="${spec%%=*}"
    rest="${spec#*=}"
    built_digest="${rest%%=*}"
    manifests=$(jq -c --arg img "$image" '.deploy[$img] // []' "$wt/.github/containers.json")
    [ "$rest" = "$built_digest" ] || manifests="${rest#*=}"
    (
      cd "$wt"
      RUNNER_TEMP="$temp" IMAGE_NAME="$image" DIGEST="$built_digest" \
        MANIFESTS="$manifests" BUILT_COMMIT="$built" bash "$record"
    )
  done
  (
    cd "$wt"
    RUNNER_TEMP="$temp" \
      GITHUB_REPOSITORY="$repository" \
      GH_TOKEN="$token" \
      CD_ACTOR="" \
      REGISTRY_OWNER=jonpulsifer \
      bash "$deliver"
  )
}

branch=cd/update-digests
queued_digest() {
  git -C "$remote" show "$branch:${manifest[$1]}" 2>/dev/null | grep -oE 'sha256:[0-9a-f]{64}' || true
}
main_digest() {
  git -C "$remote" show "main:${manifest[$1]}" | grep -oE 'sha256:[0-9a-f]{64}'
}
open_pr() { cat "$GH_STATE/open/${1//\//_}" 2>/dev/null || true; }
calls() { grep -c "^$1" "$GH_LOG" || true; }

# Empties the queue: no delivery branch, no open pull request, an empty log.
reset_queue() {
  git -C "$remote" update-ref -d "refs/heads/$branch" 2>/dev/null || true
  rm -f "$GH_STATE"/open/*
  : >"$GH_LOG"
}

m0=$(digest mate-0) m1=$(digest mate-1) m2=$(digest mate-2)
w1=$(digest weather-1) w2=$(digest weather-2)
h0=$(digest hub-0) h1=$(digest hub-1) h2=$(digest hub-2)

# Two images built in one run.
run "$c2" "mate=$m2" "weather=$w2" >"$work/log.two" 2>&1 || fail "the run failed: $(cat "$work/log.two")"
assert_equal 'a run that builds two images queues both' "$m2 $w2" "$(queued_digest mate) $(queued_digest weather)"
assert_equal 'an image the run did not build keeps the pin from main on the branch' "$h0" "$(queued_digest hub)"
assert_equal 'two images in one run make one commit' \
  "$(git -C "$remote" rev-parse main)" "$(git -C "$remote" rev-parse "$branch^")"
assert_equal 'the commit changes exactly the two deploy targets' \
  "$(printf '%s\n' "${manifest[mate]}" "${manifest[weather]}" | sort)" \
  "$(git -C "$remote" diff --name-only "main..$branch" | sort)"
assert_equal 'the commit names every image and digest it carries' \
  "$(printf 'fix(cd): update image digests\n\nmate@%s\nweather@%s' "$m2" "$w2")" \
  "$(git -C "$remote" log -1 --format=%B "$branch")"
assert_equal 'two images in one run open one pull request' 1 "$(calls 'pr create')"
grep -qF "pr create --repo $repository --title fix(cd): update image digests (mate, weather)" "$GH_LOG" \
  || fail "the pull request title does not name both images: $(grep 'pr create' "$GH_LOG")"

# The merge commit skips the push workflows. The branch commit must not, or
# the pull request's required checks never report.
grep -qxF "pr merge $branch --repo $repository --auto --squash --body [skip ci]" "$GH_LOG" \
  || fail "the digest pull request merges without [skip ci]: $(grep 'pr merge' "$GH_LOG")"
while IFS= read -r call; do
  [[ "$call" == *'--body "[skip ci]"'* ]] || fail "a merge form in the step lacks [skip ci]: $call"
done < <(grep -oE 'gh pr merge [^|]*' "$deliver")
[[ "$(git -C "$remote" log -1 --format=%B "$branch")" != *'skip ci'* ]] \
  || fail 'the delivery branch commit skips CI, so its pull request never reports its checks'

# A later run builds only a third image. The force push recuts the branch from
# main, and the two digests waiting on it must come along.
: >"$GH_LOG"
run "$c2" "hub=$h2" >"$work/log.third" 2>&1 || fail "the run failed: $(cat "$work/log.third")"
assert_equal 'a third image joins the queue' "$h2" "$(queued_digest hub)"
assert_equal 'the digests already queued survive the force push' "$m2 $w2" "$(queued_digest mate) $(queued_digest weather)"
assert_equal 'the queue is still one commit on main' \
  "$(git -C "$remote" rev-parse main)" "$(git -C "$remote" rev-parse "$branch^")"
assert_equal 'a run that joins an open queue opens no second pull request' 0 "$(calls 'pr create')"
grep -qF "pr edit 100 --repo $repository --title fix(cd): update image digests (hub, mate, weather)" "$GH_LOG" \
  || fail "the open pull request was not retitled for every image: $(cat "$GH_LOG")"

# A rerun of an older commit. hub is first, and a newer hub is queued, so the
# rerun skips it, still delivers mate, and carries the newer hub over.
reset_queue
run "$c2" "hub=$h2" >"$work/log.newer" 2>&1 || fail "the newer run failed: $(cat "$work/log.newer")"
run "$c1" "hub=$h1" "mate=$m1" >"$work/log.rerun" 2>&1 || fail "the rerun failed: $(cat "$work/log.rerun")"
assert_equal 'a rerun of an older commit does not roll back a newer queued digest' "$h2" "$(queued_digest hub)"
assert_equal 'an image skipped first does not stop the next one' "$m1" "$(queued_digest mate)"
grep -q '::notice::hub is already pinned or queued' "$work/log.rerun" \
  || fail "the rerun skipped hub without saying so: $(cat "$work/log.rerun")"

# The owner closes the pull request unmerged. Its branch outlives it, and the
# next run must not carry its digests into a new one.
rm -f "$GH_STATE/open/${branch//\//_}"
: >"$GH_LOG"
run "$c2" "weather=$w2" >"$work/log.closed" 2>&1 || fail "the run failed: $(cat "$work/log.closed")"
assert_equal 'a run after a closed pull request queues its own build' "$w2" "$(queued_digest weather)"
assert_equal 'digests from a closed pull request are not carried over' "$h0 $m0" "$(queued_digest hub) $(queued_digest mate)"
assert_equal 'a closed pull request is never edited; a new one opens' '1 0' "$(calls 'pr create') $(calls 'pr edit')"

# A queued hub that main has since moved past: carrying it over would roll hub
# back, so the guard leaves it out.
reset_queue
run "$c1" "hub=$h1" >"$work/log.h1" 2>&1 || fail "the run failed: $(cat "$work/log.h1")"
pin hub "$h2"
git -C "$seed" commit -q -am 'merge a newer hub'
git -C "$seed" push -q origin main
run "$c2" "mate=$m2" >"$work/log.moved" 2>&1 || fail "the run failed: $(cat "$work/log.moved")"
assert_equal 'a queued digest older than main is not carried over' "$h2" "$(queued_digest hub)"
assert_equal 'the queue changes only the image it built' \
  "${manifest[mate]}" "$(git -C "$remote" diff --name-only "main..$branch")"

# A digest queued on the branch each image had before. A newer one there holds
# off an older build, and an older one is superseded and its pull request
# closed.
legacy() {
  local image="$1" pinned="$2" clone="$work/legacy"
  rm -rf "$clone"
  git clone -q "$remote" "$clone"
  git -C "$clone" config user.email cd@example.com
  git -C "$clone" config user.name cd
  git -C "$clone" checkout -q -b "cd/update-$image-digest"
  sed -i -E "s|@sha256:[0-9a-f]{64}|@$pinned|" "$clone/${manifest[$image]}"
  git -C "$clone" commit -q -am "queue $image on its own branch"
  git -C "$clone" push -q -f origin "cd/update-$image-digest"
  echo 7 >"$GH_STATE/open/cd_update-$image-digest"
}

reset_queue
legacy mate "$m2"
run "$c1" "mate=$m1" "weather=$w1" >"$work/log.legacy-newer" 2>&1 || fail "the run failed: $(cat "$work/log.legacy-newer")"
assert_equal 'a newer digest on the per-image branch holds off an older build' \
  "$(main_digest mate)" "$(queued_digest mate)"
assert_equal 'the per-image pull request with the newer digest stays open' 7 "$(open_pr cd/update-mate-digest)"

reset_queue
legacy mate "$m1"
run "$c2" "mate=$m2" >"$work/log.legacy-older" 2>&1 || fail "the run failed: $(cat "$work/log.legacy-older")"
assert_equal 'a newer build replaces an older digest on the per-image branch' "$m2" "$(queued_digest mate)"
assert_equal 'the superseded per-image pull request is closed' '' "$(open_pr cd/update-mate-digest)"
grep -qF 'pr close 7 --repo jonpulsifer/infra --delete-branch --comment Superseded by #' "$GH_LOG" \
  || fail "the superseded pull request was not closed: $(cat "$GH_LOG")"
if git -C "$remote" rev-parse -q --verify refs/heads/cd/update-mate-digest >/dev/null; then
  fail 'the superseded per-image branch is still there'
fi

# An unreadable queued pin does not block delivery.
reset_queue
unknown=$(digest unknown)
queue="$work/queue"
rm -rf "$queue"
git clone -q "$remote" "$queue"
git -C "$queue" config user.email cd@example.com
git -C "$queue" config user.name cd
git -C "$queue" checkout -q -b "$branch"
sed -i -E "s|@sha256:[0-9a-f]{64}|@${unknown}|" "$queue/${manifest[mate]}"
git -C "$queue" commit -q -am 'a queued digest the registry does not know'
git -C "$queue" push -q origin "$branch"
run "$c1" "mate=$m1" >"$work/log.unknown" 2>&1 || fail "the run failed: $(cat "$work/log.unknown")"
assert_equal 'a queued digest with no readable provenance does not block delivery' "$m1" "$(queued_digest mate)"
grep -q '::warning::Cannot tell which commit' "$work/log.unknown" \
  || fail 'the unreadable pin was passed over without a warning'

# Each of these digests is a later build of c2 whose image holds the layer of
# the digest it is named after, so only its labels differ from that build.
main_mate=$(main_digest mate)
like_main=$(digest like-main)
like_m2=$(digest like-m2)
unreadable=$(digest unreadable)
publish "$like_main" "$c2" "$main_mate"
publish "$like_m2" "$c2" "$m2"
publish "$unreadable" "$c2" unreadable

reset_queue
run "$c2" "mate=$like_main" >"$work/log.same" 2>&1 || fail "the run failed: $(cat "$work/log.same")"
assert_equal 'a build with the files and config main already pins opens nothing' '' "$(queued_digest mate)"
assert_equal 'a build with the files and config main already pins calls no gh' '' "$(cat "$GH_LOG")"
grep -qF "::notice::mate build $c2 has the same filesystem and config as the pin; no pull request" "$work/log.same" \
  || fail "the content skip did not say so: $(cat "$work/log.same")"

run "$c2" "mate=$m2" >"$work/log.differs" 2>&1 || fail "the run failed: $(cat "$work/log.differs")"
assert_equal 'a build whose content differs from the pin is delivered' "$m2" "$(queued_digest mate)"

# A pull request closed unmerged leaves its branch behind, so matching the
# branch alone proves nothing about what main runs.
run "$c2" "mate=$like_m2" >"$work/log.queued-same" 2>&1 || fail "the run failed: $(cat "$work/log.queued-same")"
assert_equal 'a build matching only the queued build is delivered, since main differs' \
  "$like_m2" "$(queued_digest mate)"
if grep -qF '::notice::mate build' "$work/log.queued-same"; then
  fail 'a build matching only the queued build was skipped'
fi

run "$c2" "mate=$like_main" >"$work/log.queued-differs" 2>&1 || fail "the run failed: $(cat "$work/log.queued-differs")"
assert_equal 'a build matching main but not the queued build replaces the queued one' \
  "$like_main" "$(queued_digest mate)"

# The queue now holds main's content under another digest, so a third build of
# it matches every pin on main and on the branch.
again_main=$(digest again-main)
publish "$again_main" "$c2" "$main_mate"
run "$c2" "mate=$again_main" >"$work/log.queued-both" 2>&1 || fail "the run failed: $(cat "$work/log.queued-both")"
assert_equal 'a build matching main and the queued build leaves the queue alone' \
  "$like_main" "$(queued_digest mate)"
grep -qF "::notice::mate build $c2 has the same filesystem and config as the pin; no pull request" "$work/log.queued-both" \
  || fail "the skip against main and the queued build did not say so: $(cat "$work/log.queued-both")"

reset_queue
run "$c2" "mate=$unreadable" >"$work/log.unreadable" 2>&1 || fail "the run failed: $(cat "$work/log.unreadable")"
assert_equal 'a build whose fingerprint cannot be read is delivered as before' \
  "$unreadable" "$(queued_digest mate)"

# A run whose legs all failed has no record and does nothing.
reset_queue
run "$c2" >"$work/log.none" 2>&1 || fail "a run with no records failed: $(cat "$work/log.none")"
assert_equal 'a run with no records calls no gh' '' "$(cat "$GH_LOG")"

# The step edits main's copy of each manifest, so its targets come from main's
# deploy map and not from the built commit's.
reset_queue
old_mate="${manifest[mate]}"
renamed=clusters/offsite/apps/mate/workload.yaml
git -C "$seed" mv "$old_mate" "$renamed"
jq --arg m "$renamed" '.deploy.mate = [$m]' "$seed/.github/containers.json" >"$work/map"
mv "$work/map" "$seed/.github/containers.json"
git -C "$seed" add -A
git -C "$seed" commit -q -m 'move the deployment manifest'
git -C "$seed" push -q origin main
manifest[mate]="$renamed"

# The old target list, as the matrix of a run built before the rename has it.
run "$c2" "mate=$m2=[\"$old_mate\"]" >"$work/log.renamed" 2>&1 \
  || fail "a target renamed on main failed the step: $(cat "$work/log.renamed")"
assert_equal 'a target renamed on main since the build is followed, not refused' \
  "$m2" "$(queued_digest mate)"

# A broken target on main fails that image and the step, and the others still
# roll.
reset_queue
jq '.deploy.weather = ["clusters/folly/apps/weather/missing.yaml"]' "$seed/.github/containers.json" >"$work/map"
mv "$work/map" "$seed/.github/containers.json"
git -C "$seed" add -A
git -C "$seed" commit -q -m 'point weather at a file that is not there'
git -C "$seed" push -q origin main
if run "$c2" "mate=$m2" "weather=$w2" >"$work/log.broken" 2>&1; then
  fail 'a broken deploy target passed the step'
fi
assert_equal 'a broken target does not stop another image rolling' "$m2" "$(queued_digest mate)"
grep -q '::error::Not delivered.*weather' "$work/log.broken" \
  || fail "the step did not name the image it could not deliver: $(cat "$work/log.broken")"

reset_queue
jq 'del(.deploy.mate)' "$seed/.github/containers.json" >"$work/map"
mv "$work/map" "$seed/.github/containers.json"
git -C "$seed" add -A
git -C "$seed" commit -q -m 'stop deploying mate from this repo'
git -C "$seed" push -q origin main
run "$c2" "mate=$m2=[\"$renamed\"]" >"$work/log.dropped" 2>&1 \
  || fail "an image main no longer deploys failed the step: $(cat "$work/log.dropped")"
grep -q 'lists none' "$work/log.dropped" \
  || fail 'the step did not say why it had nothing to roll'

printf 'ok: delivery batches a run into one pull request and holds its ground against an older rerun\n'
