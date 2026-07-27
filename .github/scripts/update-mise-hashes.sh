#!/usr/bin/env bash
set -euo pipefail

FILE="${1:-nix/overlays/mise.nix}"

VERSION=$(grep -oP 'version = "\K[^"]+' "$FILE" | head -1)
if [ -z "$VERSION" ]; then
	echo "ERROR: could not extract version from $FILE" >&2
	exit 1
fi
echo "mise version: $VERSION"

compute_sri() {
	local arch="$1"
	local url="https://github.com/jdx/mise/releases/download/v${VERSION}/mise-v${VERSION}-linux-${arch}.tar.gz"
	local hash
	hash=$(curl -fsSL "$url" | openssl dgst -sha256 -binary | base64 -w0) || {
		echo "ERROR: failed to download or hash $arch tarball ($url)" >&2
		exit 1
	}
	if [ -z "$hash" ]; then
		echo "ERROR: empty hash for $arch ($url)" >&2
		exit 1
	fi
	echo "sha256-${hash}"
}

ARM64_HASH=$(compute_sri "arm64")
echo "arm64: $ARM64_HASH"

X64_HASH=$(compute_sri "x64")
echo "x64:   $X64_HASH"

sed -i "/isAarch64 then/{
n
s|\"sha256-[A-Za-z0-9+/=]*\"|\"${ARM64_HASH}\"|
}" "$FILE"

sed -i "/^[[:space:]]*else$/{
n
s|\"sha256-[A-Za-z0-9+/=]*\"|\"${X64_HASH}\"|
}" "$FILE"

if grep -qF "$ARM64_HASH" "$FILE" && grep -qF "$X64_HASH" "$FILE"; then
	echo "Hashes updated in $FILE"
else
	echo "ERROR: hash update verification failed — check $FILE" >&2
	exit 1
fi
