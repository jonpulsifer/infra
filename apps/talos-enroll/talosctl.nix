# The talosctl release binary that ./Dockerfile pins, at its version and checksum, so the anchors
# render with the same talosctl as the image. Bump the Dockerfile; this follows.
{
  lib,
  stdenvNoCC,
  fetchurl,
}:
let
  lines = lib.splitString "\n" (builtins.readFile ./Dockerfile);
  pinned =
    what: regex:
    let
      matches = lib.concatMap (
        line:
        let
          m = builtins.match regex line;
        in
        if m == null then [ ] else m
      ) lines;
    in
    if lib.length matches == 1 then
      lib.head matches
    else
      throw "apps/talos-enroll/Dockerfile must pin the talosctl ${what} exactly once";
  arch =
    {
      x86_64-linux = "amd64";
      aarch64-linux = "arm64";
    }
    .${stdenvNoCC.hostPlatform.system};
  version = pinned "version" ".*/releases/download/v([0-9]+\\.[0-9]+\\.[0-9]+)/talosctl-linux-.*";
in
stdenvNoCC.mkDerivation {
  pname = "talosctl";
  inherit version;
  src = fetchurl {
    url = "https://github.com/siderolabs/talos/releases/download/v${version}/talosctl-linux-${arch}";
    sha256 = pinned "${arch} checksum" "[[:space:]]*${arch}\\) sum=([0-9a-f]{64}) .*";
  };
  dontUnpack = true;
  # A static Go binary: nothing to patch or strip.
  dontFixup = true;
  installPhase = ''
    install -Dm0755 $src $out/bin/talosctl
  '';

  meta = {
    description = "The Talos CLI, at the version the talos-enroll image pins";
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
