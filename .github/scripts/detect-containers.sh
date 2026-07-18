#!/usr/bin/env bash
# Discovers buildable container images and outputs a GitHub Actions matrix.
#
# For each directory under apps/ and images/ that contains a Dockerfile:
#   - If build.json exists: use it (supports multiple images, custom context/args)
#   - Otherwise: image name = directory basename, context = directory
#
# Every produced image must be classified in .github/containers.json, either in
# "build" (published) or "ignore" (has a Dockerfile, intentionally not built
# here). An unclassified image fails CI, so a new app can't be silently
# published or silently dropped. Only "build" images end up in the matrix.
#
# build.json format (array of build objects):
#   [{ "image": "name", "context": ".", "file": "path/Dockerfile",
#      "build-args": "KEY=val", "platforms": "linux/amd64,linux/arm64",
#      "watch": ["extra/path"] }]
# All fields except "image" are optional.
#
# Input:  CHANGED_FILES env var — newline-separated list of changed file paths
# Output: has_changes and matrix written to GITHUB_OUTPUT

set -euo pipefail

manifest=".github/containers.json"

mapfile -t changed_files <<<"${CHANGED_FILES:-}"

# A change to the workflow, this script, or the allowlist rebuilds every image.
rebuild_all=false
if printf '%s\n' "${changed_files[@]}" | grep -qxF \
  -e '.github/workflows/containers.yml' \
  -e '.github/scripts/detect-containers.sh' \
  -e "$manifest"; then
  rebuild_all=true
fi

# Membership sets from the allowlist: is_build (publish) and is_classified
# (build ∪ ignore — anything an unclassified-image check should accept).
declare -A is_build is_classified
while IFS= read -r img; do
  is_build[$img]=1
  is_classified[$img]=1
done \
  < <(jq -r '.build[]' "$manifest")
while IFS= read -r img; do is_classified[$img]=1; done \
  < <(jq -r '.ignore[]' "$manifest")

# Returns 0 if any changed file lives under $1
path_changed() {
  local watch="$1" f
  for f in "${changed_files[@]}"; do
    [[ "$f" == "$watch" || "$f" == "$watch/"* ]] && return 0
  done
  return 1
}

includes='[]'
declare -A unclassified

mapfile -t dockerfiles < <(find apps images -name "Dockerfile" | sort)

for dockerfile in "${dockerfiles[@]}"; do
  dir=$(dirname "$dockerfile")
  base=$(basename "$dir")

  # A directory without build.json is the default case of one with a single,
  # empty entry: image=basename, context=dir, watch=dir.
  if [[ -f "$dir/build.json" ]]; then
    mapfile -t entries < <(jq -c '.[]' "$dir/build.json")
  else
    entries=('{}')
  fi

  for entry in "${entries[@]}"; do
    image=$(jq -r --arg b "$base" '.image // $b' <<<"$entry")

    [[ -n "${is_classified[$image]:-}" ]] || unclassified[$image]=1
    # Only allowlisted images are eligible for the build matrix.
    [[ -n "${is_build[$image]:-}" ]] || continue

    context=$(jq -r --arg d "$dir" '.context    // $d' <<<"$entry")
    file=$(jq -r '.file        // ""' <<<"$entry")
    build_args=$(jq -r '."build-args" // ""' <<<"$entry")
    platforms=$(jq -r '.platforms   // ""' <<<"$entry")

    should_build="$rebuild_all"
    if [[ "$should_build" != "true" ]]; then
      mapfile -t watches < <(jq -r --arg d "$dir" 'if .watch then .watch[] else $d end' <<<"$entry")
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
        --arg p "$platforms" \
        '$a + [{"image":$img,"context":$ctx,"file":$f,"build-args":$ba,"platforms":$p}]')
    fi
  done
done

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
