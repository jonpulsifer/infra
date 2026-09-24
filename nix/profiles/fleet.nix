# The baseline every deployed host gets, applied by nix/lib/mkHost.nix. Hosts diverge through
# `homelab.fleet.*` options. Images such as wsl and container take only ./base.nix.
{
  config,
  lib,
  pkgs,
  inputs,
  ...
}:
{
  imports = [
    ./base.nix
    ../system/ddnsd.nix
    ../system/home-manager.nix
    ../system/mise-dotfiles.nix
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

  # The systemd initrd locks root, so a hash makes its emergency shell reachable. In stage 2, keep
  # booting past a failed non-essential mount instead of waiting at a prompt on a headless host.
  boot.initrd.systemd.emergencyAccess = lib.mkDefault "$6$O2c3xQdTDkatgXua$9v3NubfrpZsTK7i5AiufpgB0j4Xt1lv2PTEtpzAb0Vh5sKIeXs9S8cohd2XgTe2NYZNeRxW3Q0xvU9.26Lucp1";
  systemd.enableEmergencyMode = lib.mkDefault false;

  environment.systemPackages = with pkgs; [
    bash
    bash-completion
    zsh
    git
  ];
  environment.enableAllTerminfo = config.homelab.fleet.terminfo;

  services.prometheus.exporters.node = {
    enable = lib.mkDefault config.homelab.fleet.metrics;
    openFirewall = true;
    # Unit state for the services these hosts run. The include regex limits series: the full
    # collector emits about 5 per unit, and these are small Pis.
    enabledCollectors = [ "systemd" ];
    extraFlags = [
      "--collector.systemd.unit-include=(nfs-server|nfs-mountd|rpc-statd|dnsmasq|nginx|spore-native-boot-rackpi5|coredns|chronyd|tailscaled|ddnsd|sshd|harmonia|docker)\\.service"
    ];
  };

  # docker.socket already listens on /run/docker.sock and ListenStream is a list, so the NixOS drop-in
  # adds a second bind that fails with EADDRINUSE. The leading "" resets the list.
  virtualisation.docker.listenOptions = [
    ""
    "/run/docker.sock"
  ];

  programs.zsh.enable = lib.mkDefault true;

  security.sudo = {
    enable = true;
    wheelNeedsPassword = false;
  };

  services.cron.enable = true;

  users.mutableUsers = lib.mkDefault false;
}
