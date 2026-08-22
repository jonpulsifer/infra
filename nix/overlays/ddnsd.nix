# codeberg.org/miekg/dns declares `go 1.27.0`, and the toolchain reads the
# 1.27rc3 that nixos-26.05 ships as older than that requirement. The compiler
# comes from unstable, which carries the release; everything else about the
# build stays on the pinned channel.
unstable: final: prev: {
  ddnsd = final.callPackage ../../apps/ddnsd/package.nix {
    inherit (unstable.legacyPackages.${final.stdenv.hostPlatform.system}) go_1_27;
  };
}
