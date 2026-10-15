#!/usr/bin/env bash
# Writes the build matrix of the containers.json "build" images whose watched paths
# changed or that BUILD_IMAGES names; an unclassified Dockerfile image fails.
# EVENT_NAME and BASE_SHA decide what a change to the workflow, this script or
# the allowlist builds, and what a root lockfile change builds. `--watches`
# prints `<image><TAB><path>` for every build image instead, and `--workspaces`
# `<image><TAB><workspace>` for each one that names its turbo workspace. An
# entry's "aliases" are further names the same build is pushed under.

set -euo pipefail

mode=matrix
case "${1:-}" in
  --watches) mode=watches ;;
  --workspaces) mode=workspaces ;;
  "") ;;
  *)
    echo "usage: $0 [--watches | --workspaces]" >&2
    exit 64
    ;;
esac

here="$(cd "$(dirname "$0")" && pwd)"
manifest=".github/containers.json"
workflow=".github/workflows/containers.yml"

mapfile -t changed_files <<<"${CHANGED_FILES:-}"
read -r -a forced_images <<<"${BUILD_IMAGES:-}"
# tj-actions' safe_output leaves a trailing backslash on every path but the
# last, which breaks the exact matches below.
changed_files=("${changed_files[@]%\\}")

changed() {
  local f
  for f in "${changed_files[@]}"; do
    [[ "$f" == "$1" ]] && return 0
  done
  return 1
}

# The checkout is shallow, so the base is fetched on demand. A push that
# creates a branch names an all-zero base.
base_ready() {
  [[ -n "${BASE_SHA:-}" && ! "$BASE_SHA" =~ ^0+$ ]] || return 1
  git cat-file -e "$BASE_SHA^{commit}" 2>/dev/null \
    || git fetch -q --depth=1 origin "$BASE_SHA" 2>/dev/null
}

# What the build job does to an image: that job and the permissions and env it
# inherits, less the steps that record a build for delivery and any scan of the
# pushed image. Triggers, detect, cd-guard and deliver build nothing.
build_shape() {
  yq -o=json '{"env": .env, "permissions": .permissions, "build": (.jobs.build
    | del(.steps[] | select((.name // "") | test("^(Record the build|Scan )"))))}'
}

# A side that cannot be read counts as a change, so a missing base file or a
# missing yq rebuilds every image instead of none.
shape_changed() {
  local before after
  before=$(git show "$BASE_SHA:$workflow" | build_shape) || return 0
  after=$(build_shape <"$workflow") || return 0
  [[ "$before" != "$after" ]]
}

# A pull request builds every image, without pushing, when the workflow, this
# script or the allowlist changes. On main, only a change to how the build job
# builds republishes every image, and an allowlist change builds each image
# whose `build` entry or `deploy` targets changed. Without a readable base,
# main rebuilds every image too.
rebuild_all=false
if changed "$workflow" || changed .github/scripts/detect-containers.sh \
  || changed .github/scripts/image-affected.sh || changed "$manifest"; then
  if [[ "${EVENT_NAME:-pull_request}" == pull_request ]] || ! base_ready; then
    rebuild_all=true
  else
    if changed "$workflow" && shape_changed; then
      rebuild_all=true
    fi
    if changed "$manifest"; then
      if retargeted=$(git show "$BASE_SHA:$manifest" | jq -r --slurpfile h "$manifest" '. as $b
        | [$h[0].build[] as $i
          | select(($b.build | any(. == $i) | not) or $b.deploy[$i] != $h[0].deploy[$i]) | $i]
        | join(" ")'); then
        read -r -a more <<<"$retargeted"
        forced_images+=(${more[@]+"${more[@]}"})
      else
        rebuild_all=true
      fi
    fi
  fi
fi

# Every image must be in "build" or "ignore", so a new app is never published
# or dropped silently.
declare -A is_build is_classified
while IFS= read -r img; do
  is_build[$img]=1
  is_classified[$img]=1
done \
  < <(jq -r '.build[]' "$manifest")
while IFS= read -r img; do is_classified[$img]=1; done \
  < <(jq -r '.ignore[]' "$manifest")

# The workspace files every pruned image shares. For an entry that names its
# workspace they are only a trigger for image-affected.sh.
root_file() {
  [[ "$1" == package.json || "$1" == bun.lock || "$1" == turbo.json ]]
}

path_changed() {
  local watch="$1" f
  for f in "${changed_files[@]}"; do
    [[ "$f" == "$watch" || "$f" == "$watch/"* ]] && return 0
  done
  return 1
}

includes='[]'
declare -A unclassified

# A Dockerfile under a fixtures directory is a test input.
mapfile -t dockerfiles < <(find apps images -path '*/fixtures' -prune -o -name "Dockerfile" -print | sort)

for dockerfile in "${dockerfiles[@]}"; do
  dir=$(dirname "$dockerfile")
  base=$(basename "$dir")

  # No build.json means one empty entry: image=basename, context=dir, watch=dir.
  if [[ -f "$dir/build.json" ]]; then
    mapfile -t entries < <(jq -c '.[]' "$dir/build.json")
  else
    entries=('{}')
  fi

  for entry in "${entries[@]}"; do
    image=$(jq -r --arg b "$base" '.image // $b' <<<"$entry")

    [[ -n "${is_classified[$image]:-}" ]] || unclassified[$image]=1
    [[ -n "${is_build[$image]:-}" ]] || continue

    mapfile -t watches < <(jq -r --arg d "$dir" 'if .watch then .watch[] else $d end' <<<"$entry")
    workspace=$(jq -r '.workspace // ""' <<<"$entry")

    if [[ "$mode" == workspaces ]]; then
      [[ -z "$workspace" ]] || printf '%s\t%s\n' "$image" "$workspace"
      continue
    fi
    if [[ "$mode" == watches ]]; then
      for watch in "${watches[@]}"; do
        printf '%s\t%s\n' "$image" "$watch"
      done
      continue
    fi

    context=$(jq -r --arg d "$dir" '.context    // $d' <<<"$entry")
    file=$(jq -r '.file        // ""' <<<"$entry")
    build_args=$(jq -r '."build-args" // ""' <<<"$entry")
    platforms=$(jq -r '.platforms   // ""' <<<"$entry")
    no_cache_filters=$(jq -r '."no-cache-filters" // ""' <<<"$entry")
    # A string, so the workflow tests every matrix field with `!= ''`. When set,
    # the workflow mounts GCP credentials as the `gcp_credentials` build secret.
    gcp_credentials=$(jq -r 'if ."gcp-credentials" then "true" else "" end' <<<"$entry")
    aliases=$(jq -r '(.aliases // []) | join(" ")' <<<"$entry")
    deploy_manifests=$(jq -c --arg img "$image" '.deploy[$img] // []' "$manifest")

    should_build="$rebuild_all"
    # An image in BUILD_IMAGES builds whatever changed. The stale-image pass and
    # a workflow_dispatch name images this way.
    if [[ "$should_build" != "true" ]]; then
      for forced in ${forced_images[@]+"${forced_images[@]}"}; do
        if [[ "$forced" == "$image" ]]; then
          should_build=true
          break
        fi
      done
    fi
    if [[ "$should_build" != "true" ]]; then
      root_only=false
      for watch in "${watches[@]}"; do
        path_changed "$watch" || continue
        if [[ -n "$workspace" ]] && root_file "$watch"; then
          root_only=true
          continue
        fi
        should_build=true
        break
      done
      # image-affected.sh exits 1 only when it is sure, and counts a base it
      # cannot read as a change.
      if [[ "$should_build" != "true" && "$root_only" == "true" ]]; then
        base_ready || true
        rc=0
        bash "$here/image-affected.sh" "${BASE_SHA:-}" "$(git rev-parse HEAD)" \
          "$workspace" "${watches[@]}" </dev/null || rc=$?
        [[ "$rc" -eq 1 ]] || should_build=true
      fi
    fi

    if [[ "$should_build" == "true" ]]; then
      includes=$(jq -cn --argjson a "$includes" \
        --arg img "$image" --arg ctx "$context" --arg f "$file" --arg ba "$build_args" \
        --arg p "$platforms" --arg ncf "$no_cache_filters" --arg gcp "$gcp_credentials" \
        --arg al "$aliases" --argjson m "$deploy_manifests" \
        '$a + [{"image":$img,"context":$ctx,"file":$f,"build-args":$ba,"platforms":$p,
                "no-cache-filters":$ncf,"gcp-credentials":$gcp,"aliases":$al,"manifests":$m}]')
    fi
  done
done

if [[ "$mode" != matrix ]]; then
  exit 0
fi

if [[ -n "${unclassified[*]:-}" ]]; then
  echo "error: Dockerfile image(s) missing from $manifest — add each to \"build\" or \"ignore\":" >&2
  printf '  - %s\n' "${!unclassified[@]}" >&2
  exit 1
fi

out="${GITHUB_OUTPUT:-/dev/stderr}"
if [[ $(jq 'length' <<<"$includes") -gt 0 ]]; then
  {
    echo "has_changes=true"
    echo "matrix=$(jq -c '{"include":.}' <<<"$includes")"
  } >>"$out"
else
  {
    echo "has_changes=false"
    echo 'matrix={"include":[]}'
  } >>"$out"
fi
