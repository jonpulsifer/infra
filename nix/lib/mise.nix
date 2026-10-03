# The mise the fleet installs and the dotfiles activation runs: upstream's static musl release,
# because nixpkgs' mise has no `mise dotfiles`. To bump, set version and replace each hash with
# the output of `nix store prefetch-file <url>`.
{
  lib,
  stdenvNoCC,
  fetchurl,
}:
let
  version = "2026.10.0";
  assets = {
    x86_64-linux = {
      arch = "x64";
      hash = "sha256-3zLOjLmOgBrUjtUj4w/2vP5zEcRVZ6iw27LFGB8J1DY=";
    };
    aarch64-linux = {
      arch = "arm64";
      hash = "sha256-fgorz8RPrU3RllS9EmGRWALiM0vs3Jhf+ovs/p3pywE=";
    };
  };
  system = stdenvNoCC.hostPlatform.system;
  asset =
    assets.${system}
      or (throw "mise ${version} has no pinned release for ${system}; set homelab.fleet.miseDotfiles = false");
in
stdenvNoCC.mkDerivation {
  pname = "mise";
  inherit version;

  src = fetchurl {
    url = "https://github.com/jdx/mise/releases/download/v${version}/mise-v${version}-linux-${asset.arch}-musl.tar.gz";
    inherit (asset) hash;
  };

  installPhase = ''
    runHook preInstall
    install -Dm755 bin/mise $out/bin/mise
    install -Dm644 man/man1/mise.1 $out/share/man/man1/mise.1
    runHook postInstall
  '';

  # A static binary: there is nothing to patch or strip.
  dontFixup = true;

  meta = {
    description = "Polyglot tool version manager, task runner and dotfiles manager";
    homepage = "https://mise.jdx.dev";
    license = lib.licenses.mit;
    mainProgram = "mise";
    sourceProvenance = [ lib.sourceTypes.binaryNativeCode ];
  };
}
