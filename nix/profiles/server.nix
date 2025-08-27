{
  config,
  lib,
  pkgs,
  ...
}:
{
  imports = [
    ../system/user.nix
    ../system/ddnsd.nix
    ../system/ssh.nix
    ../system/tailscale.nix
  ];

  networking = {
    hostName = lib.mkDefault "nixos";
    firewall.enable = true;
    useDHCP = true;
    useNetworkd = true;
    networkmanager.enable = lib.mkDefault false;
    wireless = {
      enable = lib.mkDefault false;
      networks = lib.mkDefault {
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
  ];
  environment.enableAllTerminfo = true;

  services.prometheus.exporters.node = {
    enable = lib.mkDefault true;
    openFirewall = lib.mkDefault true;
  };
  programs.zsh.enable = true;

  security.sudo = {
    enable = true;
    wheelNeedsPassword = false;
  };

  services.cron.enable = true;

  users.mutableUsers = false;

  nixpkgs = {
    hostPlatform = lib.mkDefault "x86_64-linux";
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
    stateVersion = "25.05";
    autoUpgrade = {
      enable = false;
      flake = "github.com:jonpulsifer/infra";
    };
  };
}
