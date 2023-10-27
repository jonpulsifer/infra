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
  services.resolved.enable = lib.mkForce false;

  programs.zsh.enable = true;
  users.users.jawn = {
    uid = lib.mkForce 1000;
    name = lib.mkDefault "jawn";
    home = lib.mkDefault "/home/jawn";
    shell = lib.mkDefault pkgs.zsh;
    description = lib.mkDefault "Jonathan Pulsifer";
  };

  nixpkgs.hostPlatform = lib.mkDefault "x86_64-linux";
  system.stateVersion = lib.mkDefault "22.11";
  system.build.installBootLoader = lib.mkForce "${pkgs.coreutils}/bin/true";
}
