{
  lib,
  pkgs,
  config,
  modulesPath,
  inputs,
  ...
}:
{
  imports = [
    (modulesPath + "/virtualisation/docker-image.nix")
    ../system/user.nix
    ../system/nixos.nix
    ../system/ssh.nix
  ];

  nixpkgs.config.allowUnfree = true;

  # Full dev stack (same as WSL image)
  home-manager.users.jawn = inputs.dotfiles.homeModules.full;

  # Container identity
  networking.hostName = "pulse";

  # Disable services not needed in a container
  system.autoUpgrade.enable = lib.mkForce false;
  services.sshguard.enable = lib.mkForce false;

  # Locale
  i18n.defaultLocale = "en_US.UTF-8";
  time.timeZone = "Canada/Atlantic";

  # Useful packages for AI agent development
  environment.systemPackages = with pkgs; [
    curl
    wget
    jq
    htop
  ];

  system.stateVersion = lib.mkDefault "25.11";
}
