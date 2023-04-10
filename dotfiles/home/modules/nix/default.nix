{ config, pkgs, ... }:
let
  inherit (pkgs.stdenv) isDarwin;
  dotfiles = "${config.home.homeDirectory}/src/github.com/jonpulsifer/dotfiles";
in
{
  home = {
    packages = with pkgs; [ cachix ];
    shellAliases = rec {
      nixpkgs = "nix repl '<nixpkgs>'";
      update = "nix flake update ${dotfiles}";
      rebuild =
        if isDarwin
        then "nix build ${dotfiles}#darwinConfigurations.$(hostname).system"
        else "nixos-rebuild build";
      switch = rebuild + " && " +
        (if isDarwin
        then "./result/sw/bin/darwin-rebuild switch --flake ${dotfiles}; unlink result"
        else "sudo nixos-rebuild -v boot && echo 'Rebooting...' && sudo reboot"
        );
    };
  };
}
