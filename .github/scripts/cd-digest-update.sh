#!/usr/bin/env bash
# Owns the two file-level decisions behind selective continuous delivery: which
# digest a manifest pins for an image right now, and whether the run asking to
# rewrite it is newer than the run that wrote what is there. The containers
# workflow keeps the git and pull-request plumbing, because that needs a real
# remote; everything here is a function of files, a registry read and the local
# commit graph, so it can be tested — and a guard nobody can test is a guard
# nobody will dare change later.
#
# Callers pass arguments and read stdout. Every explanation goes to stderr, so
# a verdict can be captured without parsing prose around it.

set -euo pipefail

usage() {
  cat >&2 <<'EOF'
usage: cd-digest-update.sh pins <image> <manifest>...
       cd-digest-update.sh rewrite <image> <digest> <manifest>...
       cd-digest-update.sh revision <repository> <digest>
       cd-digest-update.sh decide <built-commit> [pinned-commit]...
EOF
  exit 64
}

# Anchored on this image's own reference, so a manifest may pin other images
# beside it. That is not hypothetical: the in-cluster build route pins the
# BuildKit engine in the same document Spindrift's own image is pinned in, and
# the blanket rewrite this replaces refused the whole file rather than stamp
# Spindrift's digest onto BuildKit — correctly, but the effect was that every
# push stopped rolling out and said so only in a workflow log.
#
# The name must be followed by `:` or `@` so that a repository whose path
# merely starts with this one — `spindrift` and `spindrift-demo` are both
# published here — is not rewritten by it.
#
# The registry is anchored to ghcr.io because that is the only place the
# workflow pushes. A digest is content-addressed per registry, so stamping this
# one onto a ref that resolves anywhere else yields a pin that cannot be pulled
# — and the failure lands on the cluster, long after CI goes green.
image_ref() {
  printf '%s' "ghcr\.io/[^[:space:]\"']*/$1(:[^@[:space:]]+)?"
}

# Prints the digest each manifest pins for this image, one per line.
#
# Reading is deliberately best-effort where writing, below, is strict: this
# feeds a guard, and a guard that cannot read its input has learned "cannot
# tell", not "fail the build". A manifest that has moved on main, or that was
# never there, simply contributes nothing to the comparison and the strict
# checks in `rewrite` still get their say a moment later.
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

    # The unanchored shape — a chart that splits `repository:` from `tag:` —
    # only says which image it means while the file pins exactly one digest.
    # That is the same condition `rewrite` insists on before it touches such a
    # file, so reader and writer agree on what "this image's pin" means.
    lines=$(grep -cE '@sha256:[0-9a-f]{64}' "$manifest" || true)
    if [ "${lines:-0}" -eq 1 ]; then
      match=$(grep -oE '@sha256:[0-9a-f]{64}' "$manifest" | head -n1 || true)
      printf '%s\n' "${match#@}"
    fi
  done | sort -u
}

# Rewrites every manifest to pin this image at this digest. A declared target
# that is missing, or that pins no digest, means the deploy map is wrong: fail
# loudly, because a silent no-op here is indistinguishable from a successful
# deploy.
rewrite() {
  local image="$1" digest="$2" ref manifest pins_count
  shift 2
  ref=$(image_ref "$image")

  for manifest in "$@"; do
    if [ ! -f "$manifest" ]; then
      echo "::error::$manifest is a deploy target for $image but does not exist"
      exit 1
    fi

    # Refuse rather than rewrite when the manifest pins this image from
    # somewhere other than ghcr.io, so the mismatch is a red build instead of
    # an ImagePullBackOff nobody is watching for.
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

    # A chart that splits `repository:` from `tag:` puts the digest on a line
    # that never names the image, so there is nothing to anchor on and the
    # blanket rewrite is the only thing that reaches it. It is safe exactly
    # while the file pins one digest, which is what the count below is for.
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

# Prints the commit a published digest was built from, or nothing when that
# cannot be established.
#
# `docker/metadata-action` stamps `org.opencontainers.image.revision` onto
# every image the workflow builds, which makes the registry — not the git
# history of a branch nobody can trust — the record of where a pin came from.
# Reading it needs the manifest and then the config blob, never the layers.
revision() {
  local repository="$1" digest="$2" accept token doc platform config blob

  accept='application/vnd.oci.image.index.v1+json,application/vnd.docker.distribution.manifest.list.v2+json,application/vnd.oci.image.manifest.v1+json,application/vnd.docker.distribution.manifest.v2+json'

  # GHCR wants a bearer token even for a public repository, and hands an
  # anonymous one to anybody who asks for pull scope. Every image this workflow
  # publishes is public, so there is nothing to authenticate with; if that ever
  # stops being true this read returns nothing and `decide` takes its
  # cannot-tell branch rather than guessing. The retries are there because that
  # branch writes: a registry hiccup should not be the thing that decides a
  # digest is safe to overwrite.
  token=$(curl -fsS --retry 3 --retry-connrefused "https://ghcr.io/token?scope=repository:${repository}:pull&service=ghcr.io" | jq -r '.token // empty') || return 0
  [ -n "$token" ] || return 0

  doc=$(curl -fsS --retry 3 --retry-connrefused -H "Authorization: Bearer $token" -H "Accept: $accept" \
    "https://ghcr.io/v2/${repository}/manifests/${digest}") || return 0

  # The workflow builds with `provenance:` and `sbom:` on, so what it pushes is
  # an index holding the real platform images plus attestation manifests that
  # declare themselves unknown/unknown. The labels live on a platform image's
  # config; an attestation manifest has none and would read as an unlabelled
  # digest.
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

# Prints `skip` when the run building <built-commit> has nothing to add because
# a manifest already pins an image built from a later commit; `write`
# otherwise.
#
# The rule is deliberately one-sided: **skip only on proof**. Proof is that the
# built commit is a strict ancestor of a pinned build's commit, with both
# commits present in a checkout deep enough to answer honestly. Everything else
# writes and says why on stderr.
#
# Failing open is the wrong reflex for a guard, so it needs a reason. An
# unreadable pin — no revision label, a digest the registry does not hold, a
# commit that is not in this history — is a pin whose provenance nobody
# recorded, and refusing to write over it would wedge continuous delivery for
# that image permanently, with no recovery but editing the manifest by hand.
# Writing costs at most one stale pin, and it is self-correcting: the write
# records provenance, so every run after it can compare. Refusing costs an
# image that never rolls again while every check reports green, which is the
# exact failure this guard exists to end.
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

  echo write
}

case "${1:-}" in
  pins)
    [ "$#" -ge 3 ] || usage
    shift
    pins "$@"
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
