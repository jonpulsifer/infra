#!/usr/bin/env bash
# Prints the images whose pinned build is older than the newest commit touching
# their inputs. An unreadable pin is `unknown` and never rebuilds: this runs
# daily, and a wrong `stale` would rebuild and roll the image every day. For an
# image that names its turbo workspace, image-affected.sh, the test the push
# build used, has the last word, so a lockfile commit the push skipped is not
# rebuilt here. A pin whose content matches the newest build is current too.

set -euo pipefail

here="$(cd "$(dirname "$0")" && pwd)"

# Overridable so the tests can stub the registry read.
cd_digest="${CD_DIGEST_UPDATE:-$here/cd-digest-update.sh}"
detect="${DETECT_CONTAINERS:-$here/detect-containers.sh}"
image_affected="${IMAGE_AFFECTED:-$here/image-affected.sh}"
manifest="${CONTAINERS_MANIFEST:-.github/containers.json}"

# Ref prefix of the delivery branches that hold a queued, unmerged digest.
queued_prefix="${QUEUED_REF_PREFIX:-refs/cd/queued}"

usage() {
  cat >&2 <<'EOF'
usage: cd-stale-images.sh stale [image]...
       cd-stale-images.sh newest <path>...
       cd-stale-images.sh verdict <pinned-commit> <newest-commit>
EOF
  exit 64
}

# Prints nothing from a shallow clone, whose newest commit depends on the fetch
# depth. `verdict` turns the empty answer into `unknown`.
newest() {
  if [ "$(git rev-parse --is-shallow-repository 2>/dev/null || echo unknown)" != "false" ]; then
    echo "::warning::This checkout carries no commit history, so nothing can be told about what is stale." >&2
    return 0
  fi
  git log -1 --format=%H -- "$@"
}

# Prints `stale`, `current` or `unknown`.
verdict() {
  local pinned="$1" newest_commit="$2" commit

  if [ -z "$pinned" ] || [ -z "$newest_commit" ]; then
    echo unknown
    return 0
  fi
  # A shallow graft can hold both commits with no path between them, and then
  # merge-base calls a real ancestor "not an ancestor".
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
  # A pin off the ancestry line (a rerun, a revert or a force-push) counts as
  # current; cd-digest-update.sh handles that case.
  if git merge-base --is-ancestor "$pinned" "$newest_commit"; then
    echo stale
    return 0
  fi
  echo current
}

# Cached, because `--watches` walks every Dockerfile under apps/ and images/.
watch_map=""
watches_for() {
  local image="$1"
  [ -n "$watch_map" ] || watch_map=$("$detect" --watches)
  awk -F'\t' -v img="$image" '$1 == img { print $2 }' <<<"$watch_map"
}

workspace_map=""
workspace_for() {
  local image="$1"
  [ -n "$workspace_map" ] || workspace_map=$("$detect" --workspaces)
  awk -F'\t' -v img="$image" '$1 == img { print $2 }' <<<"$workspace_map"
}

# Prints the distinct verdicts for a list of digests, one per line. A stale pin
# of a workspace image is current when image-affected.sh is sure that nothing
# the image is built from changed since; it exits 1 only then.
survey() {
  local repository="$1" newest_commit="$2" workspace="$3" digest commit said rc
  shift 3
  while IFS= read -r digest; do
    [ -n "$digest" ] || continue
    # A failed read is `unknown` for this image and must not stop the pass.
    commit=$("$cd_digest" revision "$repository" "$digest" || true)
    said=$(verdict "$commit" "$newest_commit")
    if [ "$said" = stale ] && [ -n "$workspace" ]; then
      rc=0
      "$image_affected" "$commit" "$newest_commit" "$workspace" "$@" </dev/null || rc=$?
      [ "$rc" -ne 1 ] || said=current
    fi
    echo "$said"
  done | sort -u
}

# Succeeds when the newest build holds the same files and runtime config as
# every reference pin. The delivery step opens no pull request for such a
# build, so its pin keeps an older commit, and without this check the image
# would be rebuilt every day. The build tags each push with its commit; a
# scheduled rebuild is tagged with main's head instead, so `latest` counts when
# it was built from a commit that contains the newest one. Neither tag means
# the build never pushed, and the image stays stale so that it is retried.
same_content() {
  local repository="$1" newest_commit="$2" pins="$3" newest built digest

  newest=$("$cd_digest" fingerprint "$repository" "$newest_commit" || true)
  if [ -z "$newest" ]; then
    built=$("$cd_digest" revision "$repository" latest || true)
    if [ -n "$built" ] && git merge-base --is-ancestor "$newest_commit" "$built" 2>/dev/null; then
      newest=$("$cd_digest" fingerprint "$repository" latest || true)
    fi
  fi
  if [ -z "$newest" ] || [ -z "$pins" ]; then
    return 1
  fi

  while IFS= read -r digest; do
    [ -n "$digest" ] || continue
    [ "$("$cd_digest" fingerprint "$repository" "$digest" || true)" = "$newest" ] || return 1
  done <<<"$pins"
}

stale() {
  local images=("$@") image targets watches workspace newest_commit owner
  local main_pins queued_pins main_said queued_said

  # The registry looks a digest up per repository, so `revision` needs the owner.
  owner="${REGISTRY_OWNER:-${GITHUB_REPOSITORY_OWNER:-}}"
  if [ -z "$owner" ]; then
    echo "::error::REGISTRY_OWNER is unset, so no digest can be read." >&2
    return 1
  fi

  # No argument means every image with a deploy target.
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
    workspace=$(workspace_for "$image")

    # A current queued build covers every target. Main pins are per target, so
    # one stale pin names the image even when a sibling pin is current.
    main_pins=$("$cd_digest" pins "$image" "${targets[@]}")
    queued_pins=$("$cd_digest" pins-at "$queued_prefix/update-${image}-digest" "$image" "${targets[@]}")
    if [ -z "$main_pins$queued_pins" ]; then
      echo "::warning::$image is a deploy target but its manifests pin no digest, so it can never roll." >&2
      continue
    fi

    main_said=$(survey "$owner/$image" "$newest_commit" "$workspace" "${watches[@]}" <<<"$main_pins")
    queued_said=$(survey "$owner/$image" "$newest_commit" "$workspace" "${watches[@]}" <<<"$queued_pins")

    if grep -qx current <<<"$queued_said"; then
      echo "$image has a build of the newest commit touching it queued on its delivery branch." >&2
      continue
    fi
    if grep -qx unknown <<<"$queued_said" || grep -qx unknown <<<"$main_said"; then
      echo "::warning::Cannot tell which commit every pinned $image digest was built from, so this leaves it alone rather than rebuild it on a guess." >&2
      continue
    fi
    if grep -qx stale <<<"$main_said"; then
      # The same reference the delivery step compares with: what merges next.
      if same_content "$owner/$image" "$newest_commit" "${queued_pins:-$main_pins}"; then
        echo "$image is pinned at content identical to the newest build." >&2
        continue
      fi
      echo "$image is pinned behind $newest_commit, the newest commit touching its inputs." >&2
      printf '%s\n' "$image"
      continue
    fi
    echo "$image is pinned at a build current with the newest commit touching it." >&2
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
