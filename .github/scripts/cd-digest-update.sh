#!/usr/bin/env bash
# The file-level half of selective CD: the digest a manifest pins for an image,
# and whether this run is newer than the run that wrote it. `decide` prints its
# verdict on stdout and its reasons on stderr.

set -euo pipefail

usage() {
  cat >&2 <<'EOF'
usage: cd-digest-update.sh pins <image> <manifest>...
       cd-digest-update.sh pins-at <ref> <image> <manifest>...
       cd-digest-update.sh rewrite <image> <digest> <manifest>...
       cd-digest-update.sh revision <repository> <digest>
       cd-digest-update.sh decide <built-commit> [pinned-commit]...
EOF
  exit 64
}

# Anchored on ghcr.io, the only registry the workflow pushes to, and ended by
# `:` or `@` so that `spindrift` never matches `spindrift-demo`.
image_ref() {
  printf '%s' "ghcr\.io/[^[:space:]\"']*/$1(:[^@[:space:]]+)?"
}

# Prints the digest each manifest pins for this image, one per line. A missing
# manifest prints nothing; `rewrite` is the strict check.
pins() {
  local image="$1" ref manifest anchored lines match
  shift
  ref=$(image_ref "$image")

  for manifest in "$@"; do
    [ -f "$manifest" ] || continue

    anchored=$(grep -oE "${ref}@sha256:[0-9a-f]{64}" "$manifest" | grep -oE 'sha256:[0-9a-f]{64}' || true)
    if [ -n "$anchored" ]; then
      printf '%s\n' "$anchored"
      continue
    fi

    # A chart that splits `repository:` from `tag:` names no image beside the
    # digest, so it counts only when the file pins one digest, as in `rewrite`.
    lines=$(grep -cE '@sha256:[0-9a-f]{64}' "$manifest" || true)
    if [ "${lines:-0}" -eq 1 ]; then
      match=$(grep -oE '@sha256:[0-9a-f]{64}' "$manifest" | head -n1 || true)
      printf '%s\n' "${match#@}"
    fi
  done | sort -u
}

# `pins` for another ref's copy of the manifests, such as an unmerged
# cd/update-<image>-digest branch. A missing ref or file prints nothing.
pins_at() {
  local ref="$1" image="$2" tmp manifest status=0
  shift 2

  [ -n "$ref" ] || return 0
  tmp=$(mktemp -d)
  for manifest in "$@"; do
    mkdir -p "$tmp/$(dirname "$manifest")"
    git show "$ref:$manifest" >"$tmp/$manifest" 2>/dev/null || rm -f "$tmp/$manifest"
  done
  (cd "$tmp" && pins "$image" "$@") || status=$?
  rm -rf "$tmp"
  return "$status"
}

# A target that is missing or pins no digest fails: a silent no-op would look
# like a successful deploy.
rewrite() {
  local image="$1" digest="$2" ref manifest pins_count
  shift 2
  ref=$(image_ref "$image")

  for manifest in "$@"; do
    if [ ! -f "$manifest" ]; then
      echo "::error::$manifest is a deploy target for $image but does not exist"
      exit 1
    fi

    # A pin of this image from another registry fails here, before it can
    # become an ImagePullBackOff on the cluster.
    if grep -qE "[^[:space:]\"']*/${image}(:[^@[:space:]]+)?@sha256:[0-9a-f]{64}" "$manifest" \
      && ! grep -qE "${ref}@sha256:[0-9a-f]{64}" "$manifest"; then
      echo "::error::$manifest pins $image from a registry this job does not publish to; only ghcr.io digests are valid here"
      exit 1
    fi
    if grep -qE "${ref}@sha256:[0-9a-f]{64}" "$manifest"; then
      echo "Updating digest for $image in $manifest..."
      # The digest already carries the sha256: prefix, so the capture group
      # must not be replayed into the replacement.
      sed -i -E "s|(${ref})@sha256:[0-9a-f]{64}|\1@${digest}|g" "$manifest"
      continue
    fi

    # A chart that splits `repository:` from `tag:` has no image name to anchor
    # on, so the unanchored rewrite is safe only while the file pins one digest.
    pins_count=$(grep -cE '@sha256:[0-9a-f]{64}' "$manifest" || true)
    if [ "$pins_count" -eq 0 ]; then
      echo "::error::$manifest pins no image digest, so $image can never roll from it"
      exit 1
    fi
    if [ "$pins_count" -gt 1 ]; then
      echo "::error::$manifest pins $pins_count digests and names $image in none of them, so there is no way to tell which one to roll"
      exit 1
    fi
    echo "Updating digest for $image in $manifest (unanchored)..."
    sed -i -E "s|@sha256:[0-9a-f]{64}|@${digest}|g" "$manifest"
  done
}

# Prints the commit a published digest was built from, or nothing. It reads the
# org.opencontainers.image.revision label that docker/metadata-action stamps.
revision() {
  local repository="$1" digest="$2" accept token doc platform config blob

  accept='application/vnd.oci.image.index.v1+json,application/vnd.docker.distribution.manifest.list.v2+json,application/vnd.oci.image.manifest.v1+json,application/vnd.docker.distribution.manifest.v2+json'

  # GHCR wants a bearer token even for a public image and issues anonymous pull
  # tokens. The retries matter because an empty answer makes `decide` write.
  token=$(curl -fsS --retry 3 --retry-connrefused "https://ghcr.io/token?scope=repository:${repository}:pull&service=ghcr.io" | jq -r '.token // empty') || return 0
  [ -n "$token" ] || return 0

  doc=$(curl -fsS --retry 3 --retry-connrefused -H "Authorization: Bearer $token" -H "Accept: $accept" \
    "https://ghcr.io/v2/${repository}/manifests/${digest}") || return 0

  # With provenance and SBOM on, the push is an index that also holds
  # unknown/unknown attestation manifests. Only a platform image has labels.
  platform=$(jq -r '[.manifests[]? | select(.platform.os != "unknown" and .platform.architecture != "unknown")][0].digest // empty' <<<"$doc")
  if [ -n "$platform" ]; then
    doc=$(curl -fsS --retry 3 --retry-connrefused -H "Authorization: Bearer $token" -H "Accept: $accept" \
      "https://ghcr.io/v2/${repository}/manifests/${platform}") || return 0
  fi

  config=$(jq -r '.config.digest // empty' <<<"$doc")
  [ -n "$config" ] || return 0

  blob=$(curl -fsSL --retry 3 --retry-connrefused -H "Authorization: Bearer $token" \
    "https://ghcr.io/v2/${repository}/blobs/${config}") || return 0
  jq -r '.config.Labels["org.opencontainers.image.revision"] // empty' <<<"$blob"
}

# Prints `skip` when a pinned commit descends from <built-commit>, else `write`.
# One verdict covers every target, so an image never runs a mix of two builds.
decide() {
  local built="$1" pinned shallow
  shift

  shallow=$(git rev-parse --is-shallow-repository 2>/dev/null || echo unknown)

  for pinned in "$@"; do
    [ -n "$pinned" ] || continue
    if [ "$pinned" = "$built" ]; then
      echo "The manifest already pins a build of $built." >&2
      continue
    fi
    if [ "$shallow" != "false" ]; then
      echo "Cannot compare $built with the pinned build's $pinned: this checkout carries no commit history." >&2
      continue
    fi
    if ! git cat-file -e "${built}^{commit}" 2>/dev/null; then
      echo "Cannot compare: $built is not a commit in this checkout." >&2
      continue
    fi
    if ! git cat-file -e "${pinned}^{commit}" 2>/dev/null; then
      echo "Cannot compare: the pinned image was built from $pinned, which is not a commit in this checkout." >&2
      continue
    fi
    if git merge-base --is-ancestor "$built" "$pinned"; then
      echo "The manifest pins a build of $pinned, a descendant of this run's $built." >&2
      echo skip
      return 0
    fi
    echo "This run's $built is not an ancestor of the pinned build's $pinned." >&2
  done

  # Anything unproven writes: refusing an unreadable pin would stop the image
  # rolling for good, and the new pin carries a label the next run can read.
  echo write
}

case "${1:-}" in
  pins)
    [ "$#" -ge 3 ] || usage
    shift
    pins "$@"
    ;;
  pins-at)
    [ "$#" -ge 4 ] || usage
    shift
    pins_at "$@"
    ;;
  rewrite)
    [ "$#" -ge 4 ] || usage
    shift
    rewrite "$@"
    ;;
  revision)
    [ "$#" -eq 3 ] || usage
    shift
    revision "$@"
    ;;
  decide)
    [ "$#" -ge 2 ] || usage
    shift
    decide "$@"
    ;;
  *) usage ;;
esac
