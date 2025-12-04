{
  config,
  lib,
  pkgs,
  ...
}:
{
  imports = [
    ../system/ddnsd.nix
    ../system/nixos.nix
    ../system/ssh.nix
    ../system/tailscale.nix
    ../system/user.nix
  ];

  networking = {
    firewall.enable = true;
    useDHCP = true;
    useNetworkd = true;
    networkmanager.enable = lib.mkDefault false;
  };

  console.keyMap = "us";
  i18n.defaultLocale = "en_US.UTF-8";
  time.timeZone = "Canada/Atlantic";

  environment.systemPackages = with pkgs; [
    bash
    bash-completion
    zsh
    git
  ];
  environment.enableAllTerminfo = true;

  services.prometheus.exporters.node = {
    enable = lib.mkDefault true;
    openFirewall = true;
  };

  programs.zsh.enable = true;

  security.sudo = {
    enable = true;
    wheelNeedsPassword = false;
  };

  services.cron.enable = true;

  users.mutableUsers = false;
}
