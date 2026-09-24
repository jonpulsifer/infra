#!/usr/bin/env bash
# Writes the build matrix of the containers.json "build" images whose watched paths
# changed or that BUILD_IMAGES names; an unclassified Dockerfile image fails.
# `--watches` prints `<image><TAB><path>` for every build image instead.

set -euo pipefail

mode=matrix
case "${1:-}" in
  --watches) mode=watches ;;
  "") ;;
  *)
    echo "usage: $0 [--watches]" >&2
    exit 64
    ;;
esac

manifest=".github/containers.json"

mapfile -t changed_files <<<"${CHANGED_FILES:-}"
read -r -a forced_images <<<"${BUILD_IMAGES:-}"
# tj-actions' safe_output leaves a trailing backslash on every path but the
# last, which breaks the exact-match grep below.
changed_files=("${changed_files[@]%\\}")

# A change to the workflow, this script, or the allowlist rebuilds every image.
rebuild_all=false
if printf '%s\n' "${changed_files[@]}" | grep -qxF \
  -e '.github/workflows/containers.yml' \
  -e '.github/scripts/detect-containers.sh' \
  -e "$manifest"; then
  rebuild_all=true
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
      for watch in "${watches[@]}"; do
        if path_changed "$watch"; then
          should_build=true
          break
        fi
      done
    fi

    if [[ "$should_build" == "true" ]]; then
      includes=$(jq -cn --argjson a "$includes" \
        --arg img "$image" --arg ctx "$context" --arg f "$file" --arg ba "$build_args" \
        --arg p "$platforms" --arg ncf "$no_cache_filters" --arg gcp "$gcp_credentials" \
        --argjson m "$deploy_manifests" \
        '$a + [{"image":$img,"context":$ctx,"file":$f,"build-args":$ba,"platforms":$p,
                "no-cache-filters":$ncf,"gcp-credentials":$gcp,"manifests":$m}]')
    fi
  done
done

if [[ "$mode" == watches ]]; then
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
