# The talosctl release binary the anchors render with. The render must match the Talos root's
# provider, so this moves with talos_version in clusters/folly/talos/talos.tf, checksums included.
{
  lib,
  stdenvNoCC,
  fetchurl,
}:
let
  version = "1.14.4";
  arch =
    {
      x86_64-linux = "amd64";
      aarch64-linux = "arm64";
    }
    .${stdenvNoCC.hostPlatform.system};
  sha256 =
    {
      amd64 = "0a69e3f9b682c5cd844b78dae305f6056ceb86c5fcc6913dcea78c527ed97cee";
      arm64 = "a4430fad81b8dc54d99e0dc7b7ea5d0741b93645bc612cbeadf12855c4ec60bb";
    }
    .${arch};
in
stdenvNoCC.mkDerivation {
  pname = "talosctl";
  inherit version;
  src = fetchurl {
    url = "https://github.com/siderolabs/talos/releases/download/v${version}/talosctl-linux-${arch}";
    inherit sha256;
  };
  dontUnpack = true;
  # A static Go binary: nothing to patch or strip.
  dontFixup = true;
  installPhase = ''
    install -Dm0755 $src $out/bin/talosctl
  '';

  meta = {
    description = "The Talos CLI, at the version fleetd renders with";
    homepage = "https://github.com/siderolabs/talos";
    license = lib.licenses.mpl20;
    mainProgram = "talosctl";
    platforms = [
      "x86_64-linux"
      "aarch64-linux"
    ];
    sourceProvenance = [ lib.sourceTypes.binaryNativeCode ];
  };
}
