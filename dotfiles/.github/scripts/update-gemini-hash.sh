#!/usr/bin/env bash
# Post-upgrade script for Renovate to update gemini-cli-bin hash
set -euo pipefail

OVERLAYS_FILE="pkgs/overlays.nix"

# Extract the current version from overlays.nix
VERSION=$(grep -oP 'version = "\K[^"]+' "$OVERLAYS_FILE" | head -1)

if [[ -z "$VERSION" ]]; then
  echo "Error: Could not extract version from $OVERLAYS_FILE"
  exit 1
fi

echo "Updating hash for gemini-cli-bin v${VERSION}..."

# Fetch the new hash
URL="https://github.com/google-gemini/gemini-cli/releases/download/v${VERSION}/gemini.js"
NEW_HASH=$(nix-prefetch-url "$URL" 2>/dev/null | xargs nix hash convert --hash-algo sha256 --to sri)

if [[ -z "$NEW_HASH" ]]; then
  echo "Error: Could not fetch hash for $URL"
  exit 1
fi

echo "New hash: $NEW_HASH"

# Update the hash in overlays.nix
sed -i "s|hash = \"sha256-[^\"]*\"|hash = \"$NEW_HASH\"|" "$OVERLAYS_FILE"

echo "Updated $OVERLAYS_FILE with new hash"
