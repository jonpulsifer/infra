final: prev: {
  nodePackages = prev.nodePackages // {
    pnpm = prev.nodePackages.pnpm.override rec {
      version = "9.0.3";
      src = prev.fetchurl {
        url = "https://registry.npmjs.org/pnpm/-/pnpm-${version}.tgz";
        sha256 = "sha256-9b7NS3f+kVDI2JQjYS60E5RRFL9t0A/ctZQENLhHMcQ=";
      };
    };
  };
}
