{
  config,
  lib,
  pkgs,
  ...
}:
let
  inherit (lib) mkMerge;

  paths = {
    npm = "$HOME/.npm/bin";
    pnpm = "$HOME/.local/share/pnpm";
  };
in
{
  home.sessionPath = mkMerge [
    [
      paths.npm
      paths.pnpm
    ]
  ];
  home.sessionVariables = mkMerge [
    {
      NPM_CONFIG_PREFIX = paths.npm;
      PNPM_HOME = paths.pnpm;
    }
  ];
  home.packages = with pkgs; [
    biome
    bun
    pnpm_10
    nodejs_22
    nodePackages.ts-node
    nodePackages.vercel
    nodePackages.yarn
  ];
}
