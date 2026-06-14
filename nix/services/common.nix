{
  config,
  lib,
  pkgs,
  ...
}:
{
  imports = [
    ../system/chezmoi.nix
    ../system/ddnsd.nix
    ../system/nixos.nix
    ../system/ssh.nix
    ../system/tailscale.nix
    ../system/user.nix
  ];

  networking = {
    firewall.enable = true;
    useDHCP = lib.mkDefault true;
    useNetworkd = lib.mkDefault true;
    networkmanager.enable = lib.mkDefault false;
    timeServers = lib.mkDefault [
      "time.nrc.ca"
      "time.chu.nrc.ca"
    ];
  };

  console.keyMap = lib.mkDefault "us";
  i18n.defaultLocale = lib.mkDefault "en_US.UTF-8";
  time.timeZone = lib.mkDefault "Canada/Atlantic";

  boot.initrd.systemd.emergencyAccess = lib.mkDefault "$6$O2c3xQdTDkatgXua$9v3NubfrpZsTK7i5AiufpgB0j4Xt1lv2PTEtpzAb0Vh5sKIeXs9S8cohd2XgTe2NYZNeRxW3Q0xvU9.26Lucp1";

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

  programs.zsh.enable = lib.mkDefault true;

  security.sudo = {
    enable = true;
    wheelNeedsPassword = false;
  };

  services.cron.enable = true;

  users.mutableUsers = lib.mkDefault false;
}
