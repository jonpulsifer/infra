# The baseline every deployed host gets, applied unconditionally by
# nix/lib/mkHost.nix. Hosts diverge by setting a `homelab.fleet.*` option, not
# by omitting an import — an absent capability is visible in the host file
# rather than inferred from what it forgot to pull in.
#
# Image configurations that deliberately want less than this (nix/images/wsl.nix,
# nix/images/container.nix) take ./base.nix from mkImage and compose their own
# narrow import list instead.
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

  # Recoverability for headless hosts:
  # - emergencyAccess: the systemd initrd's root account is locked by default, so
  #   a failed early mount strands you with "root account is locked" at the
  #   console. A password hash here makes the initrd emergency shell reachable.
  # - enableEmergencyMode = false: in stage 2, don't hang at an emergency prompt
  #   nobody can reach on a failed *non-essential* mount; continue booting.
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
    # Unit-state metrics so Prometheus can alert on the services these hosts
    # exist to run (nfsd/dnsmasq/nginx on spore, coredns on the resolvers, ...).
    # Scoped with an include regex: the full systemd collector emits ~5
    # series per unit and these are small Pis.
    enabledCollectors = [ "systemd" ];
    extraFlags = [
      "--collector.systemd.unit-include=(nfs-server|nfs-mountd|rpc-statd|dnsmasq|nginx|spore-native-boot-rackpi5|coredns|chronyd|tailscaled|ddnsd|sshd|harmonia|docker)\\.service"
    ];
  };

  # The docker package ships its own docker.socket with
  # ListenStream=/run/docker.sock, and virtualisation.docker layers a NixOS
  # drop-in on top that sets ListenStream again. systemd treats ListenStream as
  # a list, so the drop-in appends instead of replacing: two listeners on one
  # path, and the second bind fails with EADDRINUSE. The leading "" is
  # systemd's list-reset — the same idiom the module already uses for
  # docker.service's ExecStart.
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
