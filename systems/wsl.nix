{ lib, pkgs, config, modulesPath, ... }:
with lib;
{
  wsl = {
    enable = true;
    defaultUser = "jawn";
    # Enable integration with Docker Desktop (needs to be installed separately)
    # docker.enable = true;
  };

  # resolf.conf is managed by WSL (wsl.wslConf.network.generateResolvConf)
  services.resolved.enable = lib.mkForce false;

  # users.users.jawn = {
  #   uid = lib.mkForce 1000;
  # };

  # required for vscode language server
  programs.nix-ld = {
    enable = true;
    package = pkgs.nix-ld-rs;
  };

  programs.zsh.enable = true;
  system.stateVersion = lib.mkDefault "24.05";
  system.build.installBootLoader = lib.mkForce "${pkgs.coreutils}/bin/true";
}
