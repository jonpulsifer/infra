{
  lib,
  pkgs,
  config,
  inputs,
  ...
}:
{
  imports = [
    inputs.nixos-wsl.nixosModules.default
    ../system/user.nix
    ../system/nixos.nix
  ];

  nixpkgs.config.allowUnfree = true;

  wsl = {
    enable = true;
    defaultUser = "jawn";
    useWindowsDriver = true;
    # ssh-agent.enable = true;
    # Enable integration with Docker Desktop (needs to be installed separately)
    docker-desktop.enable = true;
  };

  home-manager.users.jawn = inputs.dotfiles.homeModules.full;

  i18n.defaultLocale = "en_US.UTF-8";

  programs.ssh.startAgent = true;

  # resolf.conf is managed by WSL (wsl.wslConf.network.generateResolvConf)
  services.resolved.enable = lib.mkForce false;

  # https://nix-community.github.io/NixOS-WSL/how-to/vscode.html
  environment.systemPackages = [
    pkgs.wget
  ];

  programs.nix-ld.enable = true;

  programs.zsh.enable = true;
  system.stateVersion = lib.mkDefault "25.05";
}
