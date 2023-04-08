{ lib, pkgs, config, modulesPath, ... }:
with lib;
{
  imports = [
    "${modulesPath}/profiles/minimal.nix"
  ];
  wsl = {
    enable = true;
    wslConf.automount.root = "/mnt";
    defaultUser = "jawn";
    startMenuLaunchers = true;

    # Enable integration with Docker Desktop (needs to be installed separately)
    # docker.enable = true;
  };
  programs.zsh.enable = true;
  users.users.jawn = {
    uid = 1000;
    name = "jawn";
    home = "/home/jawn";
    shell = pkgs.zsh;
    description = "Jonathan Pulsifer";
  };

  nix = {
    package = pkgs.nixFlakes;
    settings.experimental-features = "nix-command flakes";
  };

  nixpkgs.hostPlatform = lib.mkDefault "x86_64-linux";

  system.stateVersion = "22.05";
}
