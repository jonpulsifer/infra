{ config, pkgs, lib, ... }:
let
  inherit (pkgs.stdenv) isDarwin;
  dotfiles = "${config.home.homeDirectory}/src/github.com/jonpulsifer/dotfiles";
in
{
  home = {
    packages = with pkgs; [ cachix nixpkgs-fmt ];
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
        else "sudo nixos-rebuild -v switch"
        );
    };
  };

  nix = {
    package = lib.mkDefault pkgs.nix;
    settings = {
      substituters = [
        # "https://nix.lolwtf.ca"
        "https://jonpulsifer.cachix.org"
        "https://cache.nixos.org"
        "https://nix-community.cachix.org"
      ];
      trusted-public-keys = [
        "nix.lolwtf.ca:RVHS59kCG4aWsOjbQeFRnDKrCQzc2nHt8UJrBTm/e0Y="
        "jonpulsifer.cachix.org-1:Rwya0JXhlZXczd5v3JVBgY0pU5tUbiaqw5RfFdxBakQ="
        "cache.nixos.org-1:6NCHdD59X431o0gWypbMrAURkbJ16ZPMQFGspcDShjY="
        "nix-community.cachix.org-1:mB9FSh9qf2dCimDSUo8Zy7bkq5CX+/rkCWyvRCYg3Fs="
      ];
    };
  };
}
