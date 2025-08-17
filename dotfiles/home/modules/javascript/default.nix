{
  config,
  lib,
  pkgs,
  ...
}:
let
  paths = {
    npm = "$HOME/.npm/bin";
    pnpm = "$HOME/.local/share/pnpm";
  };
in
{
  home.sessionPath = [
    paths.npm
    paths.pnpm
  ];
  home.sessionVariables = {
    NPM_CONFIG_PREFIX = paths.npm;
    PNPM_HOME = paths.pnpm;
  };
  home.packages = with pkgs; [
    bun
    nodejs
    pnpm
    nodePackages.ts-node
    nodePackages.vercel
    nodePackages.yarn
  ];
}
