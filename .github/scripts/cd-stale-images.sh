#!/usr/bin/env bash
# Names the images whose published pin is behind what `main` should already
# have produced — the images a build was dropped for.
#
# The push path builds only what the push changed, so a run that does not
# finish leaves its images pinned at the build before it and nothing later ever
# builds them again. `cd-digest-update.sh` answers "is this run older than what
# is already pinned"; this answers the opposite question, "is what is already
# pinned older than this branch", which is the one nobody was asking and the
# reason a dropped build stayed dropped.
#
# The verdict rests on `org.opencontainers.image.revision`, the commit
# `docker/metadata-action` stamps on every image this repository builds. If the
# pinned image was built from a commit that is a strict ancestor of the newest
# commit touching that image's inputs, a build is missing. That is a fact about
# two commits, not a heuristic, so it does not churn: in the steady state the
# pinned build *is* the newest commit that touched the image and nothing is
# rebuilt.
#
# **Rebuild only on proof**, which is the mirror of the rule in
# `cd-digest-update.sh` and inverted for the same reason — the costs are not
# symmetric here. This runs on a schedule, so a wrong "stale" is not one wasted
# build, it is a rebuild every day forever, and each one publishes a fresh
# digest for identical source and rolls the deployment for nothing. A wrong
# "current" costs one pin that stays stale until somebody looks. So anything
# this cannot read — a digest the registry does not hold, an image built before
# the revision label, a commit outside this checkout — is `unknown`, and
# `unknown` does not rebuild. It warns instead, because an image whose
# provenance nobody can read is a thing to fix, not to ignore.
#
# Callers pass arguments and read stdout. Every explanation goes to stderr, so
# the list of images can be captured without parsing prose around it.

set -euo pipefail

here="$(cd "$(dirname "$0")" && pwd)"

# Injectable so the tests can put a stub where the network read is. The
# workflow leaves them all unset and gets the scripts sitting next to this one.
cd_digest="${CD_DIGEST_UPDATE:-$here/cd-digest-update.sh}"
detect="${DETECT_CONTAINERS:-$here/detect-containers.sh}"
manifest="${CONTAINERS_MANIFEST:-.github/containers.json}"

# Where `cd-digest-update.sh pins-at` looks for a build that has already been
# written to its delivery branch but has not merged yet.
queued_prefix="${QUEUED_REF_PREFIX:-refs/cd/queued}"

usage() {
  cat >&2 <<'EOF'
usage: cd-stale-images.sh stale [image]...
       cd-stale-images.sh newest <path>...
       cd-stale-images.sh verdict <pinned-commit> <newest-commit>
EOF
  exit 64
}

# The newest commit reachable from HEAD that touched any of these paths.
#
# Silent rather than wrong when the checkout cannot answer: a shallow clone
# will happily name the newest commit *it* has, which is whatever the fetch
# depth happened to include, and a pinned build older than that reads as stale
# when it is not. `verdict` turns the empty answer into `unknown`.
newest() {
  if [ "$(git rev-parse --is-shallow-repository 2>/dev/null || echo unknown)" != "false" ]; then
    echo "::warning::This checkout carries no commit history, so nothing can be told about what is stale." >&2
    return 0
  fi
  git log -1 --format=%H -- "$@"
}

# `stale`, `current` or `unknown` for one pinned build against one input
# commit.
verdict() {
  local pinned="$1" newest_commit="$2" commit

  if [ -z "$pinned" ] || [ -z "$newest_commit" ]; then
    echo unknown
    return 0
  fi
  # Depth is not the question; a truncated graph is. A checkout can hold both
  # commits as objects and still have no path between them, because the history
  # that joins them stops at a graft — and `merge-base` then reports "not an
  # ancestor" about a commit that is one, so a pin genuinely left behind reads
  # as current and never gets rebuilt. That answer is indistinguishable from a
  # true one, so refuse before asking.
  if [ "$(git rev-parse --is-shallow-repository 2>/dev/null || echo unknown)" != "false" ]; then
    echo unknown
    return 0
  fi
  for commit in "$pinned" "$newest_commit"; do
    if ! git cat-file -e "${commit}^{commit}" 2>/dev/null; then
      echo "Cannot compare: $commit is not a commit in this checkout." >&2
      echo unknown
      return 0
    fi
  done
  if [ "$pinned" = "$newest_commit" ]; then
    echo current
    return 0
  fi
  # Strictly behind, and only behind. A pinned build on some commit that is not
  # an ancestor of the newest input commit is not something this should reason
  # about — it is a rerun, a revert or a force-push, and `cd-digest-update.sh`
  # owns that argument.
  if git merge-base --is-ancestor "$pinned" "$newest_commit"; then
    echo stale
    return 0
  fi
  echo current
}

# The paths that feed one image, from the map `detect-containers.sh` derives
# out of build.json. Read once and held, because deriving it walks every
# Dockerfile under apps/ and images/ and the answer cannot change while this
# runs.
watch_map=""
watches_for() {
  local image="$1"
  [ -n "$watch_map" ] || watch_map=$("$detect" --watches)
  awk -F'\t' -v img="$image" '$1 == img { print $2 }' <<<"$watch_map"
}

# The distinct verdicts one list of digests produces, one per line, for the
# caller to test with `grep -qx`. Deciding is deliberately left out, so that
# `stale` can ask this of two lists and answer differently for each.
survey() {
  local repository="$1" newest_commit="$2" digest commit
  while IFS= read -r digest; do
    [ -n "$digest" ] || continue
    # A registry read that fails outright must not take the whole pass down
    # with it: this runs unattended over every deployed image, and one bad read
    # is an `unknown` for that image, not a reason to stop looking at the other
    # nine.
    commit=$("$cd_digest" revision "$repository" "$digest" || true)
    verdict "$commit" "$newest_commit"
  done | sort -u
}

stale() {
  local images=("$@") image targets watches newest_commit owner
  local main_pins queued_pins main_said queued_said

  # The registry path every digest is read from. `cd-digest-update.sh revision`
  # takes `<owner>/<image>` because a digest is content addressed per
  # repository.
  owner="${REGISTRY_OWNER:-${GITHUB_REPOSITORY_OWNER:-}}"
  if [ -z "$owner" ]; then
    echo "::error::REGISTRY_OWNER is unset, so no digest can be read." >&2
    return 1
  fi

  # No argument means every image something actually deploys. An image with no
  # deploy target has no pin, so there is nothing for it to be behind and
  # nothing this could check.
  if [ "${#images[@]}" -eq 0 ]; then
    mapfile -t images < <(jq -r '.deploy | keys[]' "$manifest")
  fi

  for image in "${images[@]}"; do
    mapfile -t targets < <(jq -r --arg img "$image" '.deploy[$img][]? // empty' "$manifest")
    if [ "${#targets[@]}" -eq 0 ]; then
      echo "$image has no deploy target, so nothing pins it and nothing can be stale." >&2
      continue
    fi

    mapfile -t watches < <(watches_for "$image")
    if [ "${#watches[@]}" -eq 0 ]; then
      echo "::warning::$image is deployed but no Dockerfile under apps/ or images/ produces it, so its inputs are unknown." >&2
      continue
    fi

    newest_commit=$(newest "${watches[@]}")

    # Both halves of "a build already got here", exactly as the delivery step
    # reads them — but kept apart, because they do not speak for the same
    # thing.
    #
    # The delivery branch speaks for the whole image: a digest waiting there is
    # a build that already ran and is about to become what main pins, so
    # ordering a rebuild on top of it is the daily-churn failure.
    #
    # Main pins speak per deploy target, and targets drift apart — a run that
    # dropped one of an image's manifests leaves the others at the newest
    # build. Folded into one set, that current sibling vouches for the target
    # left behind and the permanently stale pin becomes invisible to the pass
    # built to end it. So one stale main pin is enough to name the image.
    main_pins=$("$cd_digest" pins "$image" "${targets[@]}")
    queued_pins=$("$cd_digest" pins-at "$queued_prefix/update-${image}-digest" "$image" "${targets[@]}")
    if [ -z "$main_pins$queued_pins" ]; then
      echo "::warning::$image is a deploy target but its manifests pin no digest, so it can never roll." >&2
      continue
    fi

    main_said=$(survey "$owner/$image" "$newest_commit" <<<"$main_pins")
    queued_said=$(survey "$owner/$image" "$newest_commit" <<<"$queued_pins")

    if grep -qx current <<<"$queued_said"; then
      echo "$image has a build of the newest commit touching it queued on its delivery branch." >&2
      continue
    fi
    if grep -qx unknown <<<"$queued_said" || grep -qx unknown <<<"$main_said"; then
      echo "::warning::Cannot tell which commit every pinned $image digest was built from, so this leaves it alone rather than rebuild it on a guess." >&2
      continue
    fi
    if grep -qx stale <<<"$main_said"; then
      echo "$image is pinned behind $newest_commit, the newest commit touching its inputs." >&2
      printf '%s\n' "$image"
      continue
    fi
    echo "$image is pinned at a build of the newest commit touching it." >&2
  done
}

case "${1:-}" in
  stale)
    shift
    stale "$@"
    ;;
  newest)
    [ "$#" -ge 2 ] || usage
    shift
    newest "$@"
    ;;
  verdict)
    [ "$#" -eq 3 ] || usage
    shift
    verdict "$@"
    ;;
  *) usage ;;
esac
