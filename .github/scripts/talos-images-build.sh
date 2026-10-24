#!/usr/bin/env bash
# Builds a site's signed Talos boot assets with the siderolabs imager: the
# SecureBoot installer, the SecureBoot ISO and the HTTP-boot UKI.
#
# usage: talos-images-build.sh <inputs.json> <keys dir> <out dir> <enroll host>
# The keys dir holds the imager's /secureboot files. crane and docker on PATH.

set -euo pipefail

if [[ $# -ne 4 ]]; then
  echo "usage: $0 <inputs.json> <keys dir> <out dir> <enroll host>" >&2
  exit 64
fi
inputs=$1 keys=$2 out=$3 enroll=$4

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

# Talos substitutes the ${...} placeholders itself, so they stay literal here.
# No client_secret: it would sit in a public file.
# shellcheck disable=SC2016
enrollment=(
  --extra-kernel-arg "talos.config=https://$enroll/config?uuid=\${uuid}&mac=\${mac}&serial=\${serial}"
  --extra-kernel-arg talos.config.oauth.client_id=talos-enroll
  --extra-kernel-arg "talos.config.oauth.device_auth_url=https://$enroll/device/code"
  --extra-kernel-arg "talos.config.oauth.token_url=https://$enroll/token"
  --extra-kernel-arg talos.config.oauth.extra_variable=uuid
  --extra-kernel-arg talos.config.oauth.extra_variable=mac
  --extra-kernel-arg talos.config.oauth.extra_variable=serial
  --extra-kernel-arg talos.config.oauth.extra_variable=hostname
  --extra-kernel-arg talos.halt_if_installed=1
)

mkdir -p "$out"
run() {
  docker run --rm --privileged -v /dev:/dev \
    -v "$keys:/secureboot:ro" -v "$out:/out" \
    "$imager" "$@"
}

# An installed node must never call the enrollment server, so neither the
# installer nor the ISO carries the enrollment arguments.
run secureboot-installer "${common[@]}"
run secureboot-iso "${common[@]}"
run secureboot-metal-uki "${common[@]}" "${enrollment[@]}"

for f in installer-amd64-secureboot.tar metal-amd64-secureboot.iso metal-amd64-secureboot-uki.efi; do
  [[ -s "$out/$f" ]] || {
    echo "missing output $out/$f" >&2
    exit 1
  }
done
