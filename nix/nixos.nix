{
  config,
  lib,
  pkgs,
  keys,
  ...
}:
let
  inherit (lib) mkDefault mkForce;
  sshKeys = lib.splitString "\n" (builtins.readFile keys);
in
{
  imports = [
    # (modulesPath + "/installer/scan/not-detected.nix")
  ];

  hardware.cpu.intel.updateMicrocode = mkDefault config.hardware.enableRedistributableFirmware;
  powerManagement.cpuFreqGovernor = mkDefault "ondemand";

  boot = {
    initrd.availableKernelModules =
      [
        "xhci_pci"
        "ahci"
        "usbhid"
        "usb_storage"
      ]
      ++ lib.optionals (builtins.elem config.networking.hostName [
        "nuc"
        "riptide"
      ]) [ "nvme" ];
    initrd.kernelModules = [ ];

    kernelPackages = mkDefault pkgs.linuxPackages_latest;
    kernelModules =
      [ ]
      ++ lib.optionals (builtins.elem config.networking.hostName [
        "nuc"
        "800g2"
        "riptide"
        "optiplex"
      ]) [ "kvm-intel" ];

    consoleLogLevel = mkDefault 0;
    extraModulePackages = [ ];

    loader = {
      # Use the systemd-boot EFI boot loader.
      systemd-boot.enable = mkDefault true;
      efi.canTouchEfiVariables = mkDefault true;
      timeout = mkDefault 0;
    };
    supportedFilesystems = mkForce [
      "ext4"
      "vfat"
    ];
  };

  fileSystems."/boot" = {
    device = "/dev/disk/by-label/boot";
    fsType = "vfat";
  };

  fileSystems."/" = mkDefault {
    device = "/dev/disk/by-label/nixos";
    fsType = "ext4";
  };

  fileSystems."/mnt/disks" = {
    device = "/dev/disk/by-label/storage";
    fsType = "ext4";
    options = [
      "nofail"
      "relatime"
    ];
  };

  swapDevices = [ ];

  networking = {
    hostName = mkDefault "nixos";
    firewall.enable = true;
    useDHCP = true;
    useNetworkd = true;
    networkmanager.enable = mkDefault false;
    wireless = {
      enable = mkDefault false;
      networks = mkDefault {
        lab = {
          hidden = true;
        };
      };
    };
  };

  console.keyMap = "us";
  i18n.defaultLocale = "en_US.UTF-8";
  time.timeZone = "Canada/Atlantic";

  environment.systemPackages = with pkgs; [
    bash
    bash-completion
    zsh
    git
    tailscale
  ];
  environment.enableAllTerminfo = true;

  services.ddnsd = {
    zone = "lolwtf.ca";
    tokenFile = "/var/secrets/cloudflare-api-token";
  };

  services.prometheus.exporters.node = {
    enable = mkDefault true;
    openFirewall = mkDefault true;
  };
  programs.zsh.enable = true;

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

    hostKeys = [
      {
        type = "ed25519";
        path = "/etc/ssh/ssh_host_ed25519_key";
      }
    ];
  };
  services.sshguard.enable = true;

  # dnssec = false is required for tailscale to work
  services.resolved = {
    enable = true;
    dnssec = "false";
  };
  services.tailscale = {
    enable = true;
    authKeyFile = "/var/secrets/tailscale-auth-key";
  };

  users.mutableUsers = false;
  users.users.jawn = {
    uid = lib.mkDefault 1337;
    isNormalUser = true;
    extraGroups = [
      "wheel"
      "tty"
    ] ++ lib.optionals (config.virtualisation.docker.enable) [ "docker" ];
    openssh.authorizedKeys.keys = sshKeys;
    shell = pkgs.zsh;
  };

  nixpkgs = {
    hostPlatform = mkDefault "x86_64-linux";
    config.allowUnfree = true;
  };

  nix = {
    package = pkgs.nixVersions.latest;
    gc = {
      automatic = true;
      dates = "weekly";
      options = "--delete-older-than 30d";
    };
    # Free up to 2GiB whenever there is less than 512MiB left.
    extraOptions = ''
      min-free = ${toString (512 * 1024 * 1024)}
      max-free = ${toString (2048 * 1024 * 1024)}
    '';
    settings = {
      auto-optimise-store = true;
      experimental-features = "nix-command flakes";
      substituters = [
        # "https://nix.lolwtf.ca"
        "https://jonpulsifer.cachix.org"
        "https://nix-community.cachix.org"
        "https://cache.nixos.org"
      ];
      trusted-public-keys = [
        "nix.lolwtf.ca:RVHS59kCG4aWsOjbQeFRnDKrCQzc2nHt8UJrBTm/e0Y="
        "jonpulsifer.cachix.org-1:Rwya0JXhlZXczd5v3JVBgY0pU5tUbiaqw5RfFdxBakQ="
        "cache.nixos.org-1:6NCHdD59X431o0gWypbMrAURkbJ16ZPMQFGspcDShjY="
        "nix-community.cachix.org-1:mB9FSh9qf2dCimDSUo8Zy7bkq5CX+/rkCWyvRCYg3Fs="
      ];
      trusted-users = [
        "root"
        config.users.users.jawn.name
      ];
    };
  };

  system = {
    stateVersion = "23.11";
    autoUpgrade = {
      enable = false;
      flake = "github.com:jonpulsifer/infra";
    };
  };
}
