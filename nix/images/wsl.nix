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
    ssh-agent.enable = true;
    # Enable integration with Docker Desktop (needs to be installed separately)
    docker-desktop.enable = true;
  };

  i18n.defaultLocale = "en_US.UTF-8";

  # resolf.conf is managed by WSL (wsl.wslConf.network.generateResolvConf)
  services.resolved.enable = lib.mkForce false;

  environment.systemPackages = [ pkgs.python3 pkgs.pipx ];

  programs.nix-ld.enable = true;

  programs.zsh.enable = true;
  system.stateVersion = "25.11";
}
