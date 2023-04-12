{ config, lib, pkgs, keys, ... }:
let
  inherit (lib) mkDefault mkForce;
in
{
  imports = [
    # Include the results of the hardware scan.
    # ./hardware-configuration.nix
  ];

  boot = {
    kernelPackages = mkDefault pkgs.linuxPackages_5_15;
    consoleLogLevel = mkDefault 0;
    loader = {
      # Use the systemd-boot EFI boot loader.
      systemd-boot.enable = mkDefault true;
      efi.canTouchEfiVariables = mkDefault true;
      timeout = mkDefault 0;
    };
  };

  networking = {
    hostName = mkDefault "nixos";
    # networkd does not support useDHCP globally
    useNetworkd = true;
    useDHCP = false;
    # interfaces.eno1.useDHCP = true;
    firewall.enable = false;
  };
  services.resolved = {
    enable = true;
    dnssec = "false";
  };
  systemd.network.enable = true;

  console.keyMap = "us";
  i18n.defaultLocale = "en_US.UTF-8";
  time.timeZone = "Canada/Atlantic";

  environment.systemPackages = with pkgs; [ bash bash-completion tailscale ];
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
  programs.zsh.enable = true;

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
  services.prometheus.exporters.node.enable = mkDefault true;
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

  users.users.jawn = {
    uid = 1337;
    isNormalUser = true;
    extraGroups = [ "wheel" "tty" ];
    openssh.authorizedKeys.keys = pkgs.lib.splitString "\n" (builtins.readFile keys);
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
    stateVersion = "22.11";
    autoUpgrade = {
      enable = true;
      flake = "github.com:jonpulsifer/infra";
    };
  };
}
