{
  lib,
  pkgs,
  config,
  inputs,
  ...
}:
{
  wsl = {
    enable = true;
    defaultUser = "jawn";
    # Enable integration with Docker Desktop (needs to be installed separately)
    # docker.enable = true;
  };

  home-manager.users.jawn = inputs.dotfiles.home.full;

  # in other systems we use the default boot loader and firewall
  # TODO: don't use nixos.nix for wsl
  boot.loader.systemd-boot.enable = false;
  networking.firewall.enable = lib.mkForce false;

  i18n.defaultLocale = "en_US.UTF-8";

  # resolf.conf is managed by WSL (wsl.wslConf.network.generateResolvConf)
  services.resolved.enable = lib.mkForce false;

  # https://nix-community.github.io/NixOS-WSL/how-to/vscode.html
  environment.systemPackages = [
    pkgs.wget
  ];

  programs.nix-ld = {
    enable = true;
    package = pkgs.nix-ld-rs;
  };

  programs.zsh.enable = true;
  system.stateVersion = lib.mkDefault "25.05";
}
