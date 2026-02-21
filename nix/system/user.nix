{
  config,
  lib,
  pkgs,
  inputs,
  ...
}:
let
  sshKeys = lib.splitString "\n" (builtins.readFile inputs.keys);
in
{
  imports = [
    inputs.home-manager.nixosModules.home-manager
  ];
  nixpkgs.overlays = [
    inputs.dotfiles.overlays.default
  ];
  home-manager.useUserPackages = true;
  home-manager.useGlobalPkgs = true;
  home-manager.users.jawn = inputs.dotfiles.homeModules.basic;

  programs.zsh.enable = true;

  users.mutableUsers = false;
  users.users.jawn = {
    uid = lib.mkForce 1337;
    isNormalUser = true;
    extraGroups = [
      "wheel"
      "tty"
    ]
    ++ lib.optionals (config.virtualisation.docker.enable) [ "docker" ];
    openssh.authorizedKeys.keys = sshKeys;
    shell = pkgs.zsh;
  };
}
