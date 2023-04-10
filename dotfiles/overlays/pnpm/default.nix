final: prev: {
  nodePackages = prev.nodePackages // {
    pnpm = prev.nodePackages.pnpm.override rec {
      version = "7.25.1";
      src = prev.fetchurl {
        url = "https://registry.npmjs.org/pnpm/-/pnpm-${version}.tgz";
        sha256 = "sha256-KuCIizquHKwInHCZ8TKCoXaHhiZ8fIaIa7cyFSGPcKQ=";
      };
    };
  };
}
