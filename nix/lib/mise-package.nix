# The flake's own `mise` input (github:jdx/mise) built for the host platform, with tests
# disabled. Shared so nix/system/user.nix and nix/system/mise-dotfiles.nix don't each
# repeat the same overrideAttrs call.
{ pkgs, inputs }:
inputs.mise.packages.${pkgs.stdenv.hostPlatform.system}.mise.overrideAttrs (_: {
  doCheck = false;
})
