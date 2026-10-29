#!/usr/bin/env bash
# Builds a site's signed Talos boot assets with the siderolabs imager: the
# SecureBoot installer and the SecureBoot ISO.
#
# usage: talos-images-build.sh <inputs.json> <keys dir> <out dir> <talos.config URL>
# The keys dir holds the imager's /secureboot files. crane and docker on PATH.

set -euo pipefail

if [[ $# -ne 4 ]]; then
  echo "usage: $0 <inputs.json> <keys dir> <out dir> <talos.config URL>" >&2
  exit 64
fi
inputs=$1 keys=$2 out=$3 config_url=$4

version=$(jq -r .talos_version "$inputs")
imager="ghcr.io/siderolabs/imager:$version"

# Each Talos release lists the extension images built for it, pinned by digest.
digests=$(crane export "ghcr.io/siderolabs/extensions:$version" - | tar -xO image-digests)

common=(--arch amd64)
while IFS= read -r ext; do
  mapfile -t refs < <(grep -E "^ghcr\.io/${ext}:" <<<"$digests" || true)
  if [[ ${#refs[@]} -ne 1 ]]; then
    echo "extension $ext: want one image in ghcr.io/siderolabs/extensions:$version, found ${#refs[@]}" >&2
    exit 1
  fi
  echo "extension: ${refs[0]}"
  common+=(--system-extension-image "${refs[0]}")
done < <(jq -r '.extensions[]' "$inputs")

while IFS= read -r arg; do
  common+=(--extra-kernel-arg "$arg")
done < <(jq -r '.extra_kernel_args[]' "$inputs")

# The installer's UKI is what an installed disk boots. On its first boot there
# is no STATE, so Talos fetches its config from the URL, filling in ${uuid} and
# the ${code} that the ramdisk wrote to META; every later boot loads the config
# from STATE. The ISO boots no installed disk and carries no URL.
config=(--extra-kernel-arg "talos.config=$config_url")

mkdir -p "$out"
run() {
  docker run --rm --privileged -v /dev:/dev \
    -v "$keys:/secureboot:ro" -v "$out:/out" \
    "$imager" "$@"
}

run secureboot-installer "${common[@]}" "${config[@]}"
run secureboot-iso "${common[@]}"

for f in installer-amd64-secureboot.tar metal-amd64-secureboot.iso; do
  [[ -s "$out/$f" ]] || {
    echo "missing output $out/$f" >&2
    exit 1
  }
done
