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

  networking.hostName = "pulse";

  system.autoUpgrade.enable = lib.mkForce false;
  services.sshguard.enable = lib.mkForce false;

  i18n.defaultLocale = "en_US.UTF-8";
  time.timeZone = "Canada/Atlantic";

  environment.systemPackages = with pkgs; [
    curl
    wget
    jq
    htop
  ];
}
