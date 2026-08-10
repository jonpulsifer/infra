{
  config,
  lib,
  pkgs,
  ...
}:
{
  nixpkgs = {
    hostPlatform = lib.mkDefault "x86_64-linux";
    config.allowUnfree = true;
  };

  nix = {
    package = pkgs.nixVersions.latest;
    gc = {
      automatic = true;
      dates = lib.mkDefault "weekly";
      options = lib.mkDefault "--delete-older-than 30d";
    };
    # Free up to 5GiB whenever there is less than 2GiB left.
    extraOptions = ''
      min-free = ${toString (2 * 1024 * 1024 * 1024)}
      max-free = ${toString (5 * 1024 * 1024 * 1024)}
    '';
    settings = {
      auto-optimise-store = true;
      experimental-features = "nix-command flakes";
      substituters = [
        "https://jonpulsifer.cachix.org"
        "https://nix-community.cachix.org"
        "https://cache.nixos.org"
      ];
      trusted-public-keys = [
        "jonpulsifer.cachix.org-1:Rwya0JXhlZXczd5v3JVBgY0pU5tUbiaqw5RfFdxBakQ="
        "cache.nixos.org-1:6NCHdD59X431o0gWypbMrAURkbJ16ZPMQFGspcDShjY="
        "nix-community.cachix.org-1:mB9FSh9qf2dCimDSUo8Zy7bkq5CX+/rkCWyvRCYg3Fs="
      ];
      trusted-users = [
        config.users.users.jawn.name
      ];
    };
  };

  system = {
    autoUpgrade = {
      enable = lib.mkDefault true;
      flake = "git+https://github.com/jonpulsifer/infra.git";
      flags = [ "-L" ];
      dates = "03:37";
      randomizedDelaySec = "3600";
    };
  };

  # Run pre-linked binaries (mise-managed tools, downloaded releases, vendor
  # installers) on NixOS: `programs.nix-ld.enable` installs the dynamic loader
  # such binaries expect and exports `NIX_LD` / `NIX_LD_LIBRARY_PATH` so they
  # find it. Anything needing more than glibc gets its library closure surfaced
  # by adding paths to `environment.variables.NIX_LD_LIBRARY_PATH` per host.
  programs.nix-ld.enable = lib.mkDefault true;
}
