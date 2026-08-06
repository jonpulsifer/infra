# Overlay that replaces the from-source `mise` (built by the jdx/mise flake
# input, which compiles Rust on every host) with a derivation that just
# fetches the matching prebuilt binary from the GitHub release tarball and
# patchelfs it for NixOS' glibc.
#
# Only x86_64-linux and aarch64-linux have upstream release assets. armv6l
# (radiopi0 / blinkypi0) is intentionally left to throw -- those hosts drop
# mise from the user package set entirely (see nix/hosts/{radiopi0,blinkypi0}.nix)
# so pkgs.mise is never instantiated there and this throw never fires.
final: _prev:
let
  # Renovate bumps `version` only (the fetchurl hashes are not covered).
  # A postUpgradeTask can't refresh them automatically: `allowedCommands` is
  # a Renovate global-only option the Mend-hosted `renovate[bot]` app does not
  # expose for this repo, so the task would be skipped. Refresh the hashes by
  # hand before merging the bump PR — run .github/scripts/update-mise-hashes.sh,
  # or the nix-prefetch-url commands below. CI flags a stale hash, quoting the
  # correct replacement:
  #   nix-prefetch-url --type sha256 \
  #     https://github.com/jdx/mise/releases/download/v<ver>/mise-v<ver>-linux-arm64.tar.gz
  #   nix-prefetch-url --type sha256 \
  #     https://github.com/jdx/mise/releases/download/v<ver>/mise-v<ver>-linux-x64.tar.gz
  # (nix hash to-sri --type sha256 <h> gives the `sha256-...` SRI form.)
  # renovate: datasource=github-releases depName=jdx/mise
  version = "2026.8.1";
  arch =
    if final.stdenv.hostPlatform.isAarch64 then
      "arm64"
    else if final.stdenv.hostPlatform.isx86_64 then
      "x64"
    else
      throw "mise prebuilt binary: upstream has no release for ${final.stdenv.hostPlatform.system}";
in
{
  mise = final.stdenv.mkDerivation {
    pname = "mise";
    inherit version;

    src = final.fetchurl {
      url = "https://github.com/jdx/mise/releases/download/v${version}/mise-v${version}-linux-${arch}.tar.gz";
      hash =
        if final.stdenv.hostPlatform.isAarch64 then
          "sha256-bYiLo9C1149nZ3GoSEaIW39oX7TRUz8pJweeubdWM6g="
        else
          "sha256-ZBg2A4VPMZt4ZYMFxUWqyuk14JWaOolLd6D5QW6rBHs=";
    };

    # The tarball unpacks into ./mise/{bin,man,...}; set sourceRoot so the
    # install phase can address it directly.
    sourceRoot = ".";

    nativeBuildInputs = [ final.autoPatchelfHook ];
    # The prebuilt binary is dynamically linked against glibc + libgcc_s.
    buildInputs = [
      final.glibc
      final.gcc-unwrapped.lib
    ];

    installPhase = ''
      runHook preInstall
      install -Dm555 mise/bin/mise      $out/bin/mise
      install -Dm444 mise/man/man1/mise.1 $out/share/man/man1/mise.1
      runHook postInstall
    '';

    # The downloaded binary is already stripped; keep autoPatchelf from
    # re-running strip with mismatched toolchain expectations.
    dontStrip = true;

    meta = with final.lib; {
      description = "Polyglot runtime manager (prebuilt upstream binary)";
      homepage = "https://github.com/jdx/mise";
      license = licenses.mit;
      mainProgram = "mise";
      platforms = [
        "x86_64-linux"
        "aarch64-linux"
      ];
    };
  };
}
