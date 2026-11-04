# The talosctl release binary the anchors render with. The render must match the Talos root's
# provider, so this moves with talos_version in clusters/folly/talos/talos.tf, checksums included.
{
  lib,
  stdenvNoCC,
  fetchurl,
}:
let
  version = "1.14.5";
  arch =
    {
      x86_64-linux = "amd64";
      aarch64-linux = "arm64";
    }
    .${stdenvNoCC.hostPlatform.system};
  sha256 =
    {
      amd64 = "ff432b68986709e6b69c563a08a2ced4232d5196b0dccd6d2e783e9d714d7d7d";
      arm64 = "dfd3aa33c3159810e216fc39afb685d4d120c8f2728e017d8c7f7635d3139382";
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
