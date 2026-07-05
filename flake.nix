{
  description = "the homelab";

  nixConfig = {
    extra-substituters = [
      "https://nixos-raspberrypi.cachix.org"
    ];
    extra-trusted-public-keys = [
      "nixos-raspberrypi.cachix.org-1:4iMO9LXa8BqhU+Rpg6LQKiGa2lsNh/j2oiYLNOQ5sPI="
    ];
  };

  inputs = {
    nixpkgs.url = "github:nixos/nixpkgs/nixos-26.05";
    nixos-hardware.url = "github:nixos/nixos-hardware";
    nixos-raspberrypi.url = "github:nvmd/nixos-raspberrypi/main";
    nixos-wsl = {
      url = "github:nix-community/NixOS-WSL/release-26.05";
      inputs.nixpkgs.follows = "nixpkgs";
    };
    unstable.url = "github:nixos/nixpkgs/nixos-unstable";

    disko = {
      url = "github:nix-community/disko";
      inputs.nixpkgs.follows = "nixpkgs";
    };

    hosts = {
      url = "github:StevenBlack/hosts";
      inputs.nixpkgs.follows = "nixpkgs";
    };

    mise = {
      url = "github:jdx/mise";
      inputs.nixpkgs.follows = "nixpkgs";
    };

    keys = {
      url = "https://github.com/jonpulsifer.keys";
      flake = false;
    };
    rowbuttkeys = {
      url = "https://github.com/rowbutt.keys";
      flake = false;
    };
    wannabekeys = {
      url = "https://github.com/wannabehero.keys";
      flake = false;
    };
  };

  outputs =
    inputs@{ nixpkgs, ... }:
    let
      lib = nixpkgs.lib;
      inherit (lib) genAttrs nixosSystem;

      systems = [
        "x86_64-linux"
        "aarch64-linux"
      ];
      forAllSystems = f: genAttrs systems (system: f system);

      inherit
        (import ./nix/lib/mkHost.nix {
          inherit lib nixosSystem inputs;
        })
        mkHost
        mkImage
        ;

      deployHosts = [
        "optiplex"
        "riptide"
        "shale"
        "oldschool"
        "retrofit"
        "cloudpi4"
        "homepi4"
        "weatherpi4"
        "rackpi5"
        "oldboy"
      ];

      legacyPackages = forAllSystems (
        system:
        import nixpkgs {
          inherit system;
          config.allowUnfree = true;
        }
      );
    in
    rec {
      nixosConfigurations = {
        optiplex = mkHost "optiplex" {
          role = "control-plane";
          tags = [ "folly" ];
          imports = [
            ./nix/system/tailscale-disable.nix
          ];
          extraConfig.homelab.disko.device = "/dev/sda";
        };
        riptide = mkHost "riptide" {
          tags = [ "folly" ];
          imports = [
            ./nix/system/tailscale-disable.nix
          ];
          extraConfig.homelab.disko.device = "/dev/nvme0n1";
        };
        shale = mkHost "shale" {
          tags = [ "folly" ];
          imports = [
            ./nix/system/tailscale-disable.nix
          ];
          extraConfig.homelab.disko.device = "/dev/sda";
        };

        oldschool = mkHost "oldschool" {
          tags = [ "offsite" ];
          imports = [
            ./nix/system/quiker.nix
            ./nix/system/tailscale-disable.nix
            ./nix/services/github-runner.nix
            ./nix/services/yarr.nix
          ];
          extraConfig = {
            virtualisation.docker.enable = true;
            homelab.disko.device = "/dev/sda";
          };
        };
        retrofit = mkHost "retrofit" {
          tags = [ "offsite" ];
          role = "control-plane";
          imports = [
            ./nix/system/tailscale-disable.nix
          ];
          extraConfig.homelab.disko.device = "/dev/sda";
        };

        cloudpi4 = mkHost "cloudpi4" {
          system = "aarch64-linux";
          modules = [ ./nix/hosts/cloudpi4.nix ];
        };
        homepi4 = mkHost "homepi4" {
          system = "aarch64-linux";
          modules = [ ./nix/hosts/homepi4.nix ];
        };
        weatherpi4 = mkHost "weatherpi4" {
          system = "aarch64-linux";
          modules = [ ./nix/hosts/weatherpi4.nix ];
        };
        rackpi5 = mkHost "rackpi5" {
          system = "aarch64-linux";
          modules = [ ./nix/hosts/rackpi5.nix ];
        };

        oldboy = mkHost "oldboy" {
          tags = [ "gcp" ];
          modules = [ ./nix/hosts/oldboy.nix ];
        };

        wsl = mkImage ./nix/images/wsl.nix;
        iso = mkImage ./nix/images/iso.nix;
        gce = mkImage ./nix/images/gce.nix;
        container = mkImage ./nix/images/container.nix;
        netboot = mkImage ./nix/images/netboot.nix;
      };

      packages = {
        x86_64-linux = {
          iso = nixosConfigurations.iso.config.system.build.isoImage;
          wsl = nixosConfigurations.wsl.config.system.build.tarballBuilder;
          container = nixosConfigurations.container.config.system.build.tarball;
          gce = nixosConfigurations.gce.config.system.build.googleComputeImage;
          oldboy = nixosConfigurations.oldboy.config.system.build.googleComputeImage;
          netboot = legacyPackages.x86_64-linux.symlinkJoin {
            name = "netboot";
            paths = with nixosConfigurations.netboot.config.system.build; [
              netbootRamdisk
              kernel
              netbootIpxeScript
            ];
            preferLocalBuild = true;
          };
        };
        aarch64-linux = {
          cloudpi4 = nixosConfigurations.cloudpi4.config.system.build.sdImage;
          homepi4 = nixosConfigurations.homepi4.config.system.build.sdImage;
          weatherpi4 = nixosConfigurations.weatherpi4.config.system.build.sdImage;
          rackpi5 = nixosConfigurations.rackpi5.config.system.build.sdImage;
        };
      };

      inherit legacyPackages;

      formatter = forAllSystems (system: legacyPackages.${system}.nixfmt-tree);

      devShells = forAllSystems (system: {
        default = import ./shell.nix {
          pkgs = legacyPackages.${system};
        };
      });

      apps = forAllSystems (
        system:
        (import ./nix/lib/apps.nix).mkApps {
          pkgs = legacyPackages.${system};
          inherit deployHosts nixosConfigurations;
        }
      );
    };
}
