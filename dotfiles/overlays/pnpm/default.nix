final: prev: {
  nodePackages = prev.nodePackages // {
    pnpm = prev.nodePackages.pnpm.override rec {
      version = "9.1.4";
      src = prev.fetchurl {
        url = "https://registry.npmjs.org/pnpm/-/pnpm-${version}.tgz";
        sha256 = "sha256-MKGAGsTnI3ee/tE6IfTDn562yfu0ztEBvOBrQiWT18k=";
      };
    };
  };
}
