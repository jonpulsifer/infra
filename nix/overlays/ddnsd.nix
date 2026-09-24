# codeberg.org/miekg/dns requires go 1.27.0, and nixos-26.05's 1.27rc3 sorts older, so only
# the compiler comes from unstable.
unstable: final: prev: {
  ddnsd = final.callPackage ../../apps/ddnsd/package.nix {
    inherit (unstable.legacyPackages.${final.stdenv.hostPlatform.system}) go_1_27;
  };
}
