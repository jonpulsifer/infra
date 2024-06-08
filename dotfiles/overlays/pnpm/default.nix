final: prev: {
  nodePackages = prev.nodePackages // {
    pnpm = prev.nodePackages.pnpm.override rec {
      version = "9.2.0";
      src = prev.fetchurl {
        url = "https://registry.npmjs.org/pnpm/-/pnpm-${version}.tgz";
        sha256 = "sha256-lPqyE98iHFW2lWsUoiZMIcYgPMqfCzuV/y/puEsSA5A=";
      };
    };
  };
}
