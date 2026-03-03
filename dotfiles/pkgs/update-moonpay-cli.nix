{
  writeShellApplication,
  curl,
  jq,
  nodejs,
  prefetch-npm-deps,
  gnused,
  coreutils,
}:
writeShellApplication {
  name = "update-moonpay-cli";
  runtimeInputs = [
    curl
    jq
    nodejs
    prefetch-npm-deps
    gnused
    coreutils
  ];
  text = ''
    NIX_FILE="pkgs/moonpay-cli.nix"
    LOCK_FILE="pkgs/moonpay-cli-package-lock.json"

    if [[ ! -f "$NIX_FILE" ]]; then
      echo "Error: $NIX_FILE not found. Run from the dotfiles repo root." >&2
      exit 1
    fi

    VERSION="''${1:-}"
    if [[ -z "$VERSION" ]]; then
      VERSION=$(sed -n 's/.*version = "\([^"]*\)".*/\1/p' "$NIX_FILE" | head -1)
    fi

    if [[ -z "$VERSION" ]]; then
      echo "Error: could not determine version" >&2
      exit 1
    fi

    echo "==> Updating MoonPay CLI to v$VERSION"

    URL="https://registry.npmjs.org/@moonpay/cli/-/cli-''${VERSION}.tgz"

    echo "==> Prefetching source tarball..."
    SRC_HASH=$(nix store prefetch-file --json --hash-type sha256 "$URL" | jq -r '.hash')
    echo "    hash: $SRC_HASH"

    TMPDIR=$(mktemp -d)
    trap 'rm -rf "$TMPDIR"' EXIT

    echo "==> Downloading and extracting tarball..."
    curl -sL "$URL" | tar xz -C "$TMPDIR"

    echo "==> Generating package-lock.json..."
    (cd "$TMPDIR/package" && npm install --package-lock-only --ignore-scripts --include=optional 2>/dev/null)
    cp "$TMPDIR/package/package-lock.json" "$LOCK_FILE"

    echo "==> Prefetching npm dependencies (this may take a minute)..."
    NPM_DEPS_HASH=$(prefetch-npm-deps "$LOCK_FILE" 2>/dev/null)
    echo "    npmDepsHash: $NPM_DEPS_HASH"

    echo "==> Updating $NIX_FILE..."
    sed -i "s|version = \"[^\"]*\"|version = \"$VERSION\"|" "$NIX_FILE"
    sed -i '/fetchurl/,/};/{s|hash = "sha256-[^"]*"|hash = "'"$SRC_HASH"'"|;}' "$NIX_FILE"
    sed -i 's|npmDepsHash = "sha256-[^"]*"|npmDepsHash = "'"$NPM_DEPS_HASH"'"|' "$NIX_FILE"

    echo "==> Done!"
    echo "    version:     $VERSION"
    echo "    hash:        $SRC_HASH"
    echo "    npmDepsHash: $NPM_DEPS_HASH"
  '';
}
