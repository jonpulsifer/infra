{ config, lib, pkgs, keys, needsRoutes, ... }:
let
  inherit (lib) mkDefault mkForce;
  sshKeys = lib.splitString "\n" (builtins.readFile keys);
in
{
  imports = [
    # Include the results of the hardware scan.
    # ./hardware-configuration.nix
  ];

  boot = {
    kernelPackages = mkDefault pkgs.linuxPackages_latest;
    consoleLogLevel = mkDefault 0;
    loader = {
      # Use the systemd-boot EFI boot loader.
      systemd-boot.enable = mkDefault true;
      efi.canTouchEfiVariables = mkDefault true;
      timeout = mkDefault 0;
    };
    supportedFilesystems = mkForce [ "ext4" "vfat" ];
  };

  networking = {
    hostName = mkDefault "nixos";
    firewall.enable = true;
    useDHCP = false;
    wireless = {
      enable = false;
      networks = mkDefault { lab = { hidden = true; }; };
    };
  };

  # dnssec = false is required for tailscale to work
  services.resolved = { enable = true; dnssec = "false"; };
  systemd.network =
    let
      networkConfig = { DHCP = "yes"; DNSSEC = false; DNSOverTLS = "opportunistic"; };
      linkConfig = { RequiredForOnline = false; };
      dhcpV4Config = { UseRoutes = true; };
      k8s-routes = [
        { routeConfig = { Gateway = "10.2.0.5"; Destination = "10.3.0.0/24"; GatewayOnLink = true; }; }
        { routeConfig = { Gateway = "10.2.0.5"; Destination = "10.100.0.0/16"; GatewayOnLink = true; }; }
      ];
    in
    {
      enable = true;
      networks."10-wired" = {
        inherit dhcpV4Config linkConfig networkConfig;
        matchConfig.Name = "en* eth*";
        routes = [{ routeConfig = { Gateway = "_dhcp4"; Metric = 100; Destination = "0.0.0.0/0"; }; }] ++ lib.optionals needsRoutes k8s-routes;
      };
      networks."11-wlan" = {
        inherit dhcpV4Config linkConfig networkConfig;
        matchConfig.Name = "wl*";
        routes = [{ routeConfig = { Gateway = "_dhcp4"; Metric = 200; Destination = "0.0.0.0/0"; }; }] ++ lib.optionals needsRoutes k8s-routes;
      };
    };

  console.keyMap = "us";
  i18n.defaultLocale = "en_US.UTF-8";
  time.timeZone = "Canada/Atlantic";

  environment.systemPackages = with pkgs; [ bash bash-completion zsh git tailscale ];
  services.prometheus.exporters.node = {
    enable = mkDefault true;
    openFirewall = mkDefault true;
  };
  programs.zsh.enable = true;

  services.getty.autologinUser = mkDefault "root";
  security.sudo = {
    enable = true;
    wheelNeedsPassword = false;
  };

  programs.ssh.startAgent = true;
  programs.gnupg.agent = {
    enable = false;
    enableExtraSocket = true;
    enableSSHSupport = true;
  };

  services.cron.enable = true;
  services.openssh = {
    enable = true;
    settings = {
      AllowAgentForwarding = true;
      ChallengeResponseAuthentication = false;
      KbdInteractiveAuthentication = false;
      PasswordAuthentication = false;
      PermitRootLogin = mkDefault "no";
    };

    hostKeys = [{
      type = "ed25519";
      path = "/etc/ssh/ssh_host_ed25519_key";
    }];
  };
  services.sshguard.enable = true;
  services.tailscale.enable = true;
  systemd.services.tailscale-autoconnect = {
    description = "Automatic connection to Tailscale";

    # make sure tailscale is running before trying to connect to tailscale
    after = [ "network-pre.target" "tailscale.service" ];
    wants = [ "network-pre.target" "tailscale.service" ];
    wantedBy = [ "multi-user.target" ];

    # set this service as a oneshot job
    serviceConfig.Type = "oneshot";

    # have the job run this shell script
    script = with pkgs; ''
      # wait for tailscaled to settle
      sleep 2

      # check if we are already authenticated to tailscale
      status="$(${tailscale}/bin/tailscale status -json | ${jq}/bin/jq -r .BackendState)"
      if [ $status = "Running" ]; then # if so, then do nothing
        exit 0
      fi

      # otherwise authenticate with tailscale
      ${tailscale}/bin/tailscale up --auth-key file:/var/secrets/tailscale-auth-key
    '';
  };

  virtualisation.docker.enable = false;
  users.mutableUsers = false;
  users.users.jawn = {
    uid = 1337;
    isNormalUser = true;
    extraGroups = [ "wheel" "tty" ] ++ lib.optionals (config.virtualisation.docker.enable) [ "docker" ];
    openssh.authorizedKeys.keys = sshKeys;
    shell = pkgs.zsh;
  };

  nix = {
    package = pkgs.nixFlakes;
    gc = {
      automatic = true;
      dates = "weekly";
      options = "--delete-older-than 30d";
    };
    # Free up to 1GiB whenever there is less than 100MiB left.
    extraOptions = ''
      min-free = ${toString (100 * 1024 * 1024)}
      max-free = ${toString (1024 * 1024 * 1024)}
    '';
    settings = {
      auto-optimise-store = true;
      experimental-features = "nix-command flakes";
      substituters = [
        "https://cache.nixos.org"
        "https://nix-community.cachix.org"
        "https://jonpulsifer.cachix.org"
      ];
      trusted-public-keys = [
        "cache.nixos.org-1:6NCHdD59X431o0gWypbMrAURkbJ16ZPMQFGspcDShjY="
        "nix-community.cachix.org-1:mB9FSh9qf2dCimDSUo8Zy7bkq5CX+/rkCWyvRCYg3Fs="
        "jonpulsifer.cachix.org-1:Rwya0JXhlZXczd5v3JVBgY0pU5tUbiaqw5RfFdxBakQ="
      ];
      trusted-users = [ "root" config.users.users.jawn.name ];
    };
  };

  system = {
    stateVersion = "23.05";
    autoUpgrade = {
      enable = true;
      flake = "github.com:jonpulsifer/infra";
    };
  };
}
