{ config, lib, pkgs, keys, ... }:
let
  inherit (lib) mkDefault mkForce;
in
{
  # Required for the Wireless firmware
  hardware.enableRedistributableFirmware = true;
  # nixpkgs = { 
  #   buildPlatform.system = "x86_64-linux";
  #   hostPlatform.system = "aarch64-linux";
  # };
  boot = {
    kernelPackages = pkgs.linuxPackages_rpi4;
    kernelParams = [
      "cma=128M"
      "cgroup_enable=cpuset"
      "cgroup_memory=1"
      "cgroup_enable=memory"
    ];

    tmpOnTmpfs = true;

    consoleLogLevel = 7;
    loader = {
      grub.enable = mkDefault false;
      #raspberryPi = {
      #  enable = mkDefault true;
      #  version = 4;
      #};
      # Use the systemd-boot EFI boot loader.
      # systemd-boot.enable = true;
      # efi.canTouchEfiVariables = true;
      timeout = mkForce 0;
    };
  };

  networking = {
    hostName = mkDefault "nixos";
    # nameservers = mkDefault [ "1.1.1.1" "1.0.0.1" ];
    # useNetworkd = false;
    # useDHCP = true;
    interfaces.eth0.useDHCP = true;
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
      trusted-users = [ "root" "jawn" ];
    };
  };

  systemd.network.enable = true;

  console.keyMap = "us";
  i18n.defaultLocale = "en_US.UTF-8";

  time.timeZone = "Canada/Atlantic";

  environment.systemPackages = with pkgs; [ bash bash-completion tailscale ];

  services.prometheus.exporters.node.enable = mkDefault true;
  services.cron.enable = true;
  services.sshguard.enable = true;
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

  programs.ssh.startAgent = true;
  programs.gnupg.agent = {
    enable = false;
    enableExtraSocket = true;
    enableSSHSupport = true;
  };

  programs.zsh.enable = true;

  security.sudo = {
    enable = true;
    wheelNeedsPassword = false;
  };

  users.users.jawn = {
    uid = 1337;
    isNormalUser = true;
    extraGroups = [ "wheel" ];
    openssh.authorizedKeys.keys = pkgs.lib.splitString "\n" (builtins.readFile keys);
    shell = pkgs.zsh;
  };

  system = {
    stateVersion = "23.05";
    autoUpgrade = {
      enable = true;
      flake = "github.com:jonpulsifer/infra";
    };
  };
}
