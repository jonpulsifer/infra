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
    PNPM_HOME = paths.pnpm;
  };
  home.packages = with pkgs; [
    bun
    nodejs
    pnpm
  ];
}
