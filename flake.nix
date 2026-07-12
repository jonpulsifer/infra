{
  description = "the homelab";

  nixConfig = {
    accept-flake-config = true;
    extra-substituters = [
      "https://nixos-raspberrypi.cachix.org"
      "https://nix-community.cachix.org"
    ];
    extra-trusted-public-keys = [
      "nixos-raspberrypi.cachix.org-1:4iMO9LXa8BqhU+Rpg6LQKiGa2lsNh/j2oiYLNOQ5sPI="
      "nix-community.cachix.org-1:mB9FSh9qf2dCimDSUo8Zy7bkq5CX+/rkCWyvRCYg3Fs="
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

    sops-nix = {
      url = "github:Mic92/sops-nix";
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
        "dns"
        "rackpi5"
        "oldboy"
        "spore"
        "radiopi0"
        "blinkypi0"
      ];

      legacyPackages = forAllSystems (
        system:
        import nixpkgs {
          inherit system;
          config.allowUnfree = true;
        }
      );

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
            ./nix/system/sops.nix
            ./nix/services/github-runner.nix
            ./nix/services/yarr.nix
          ];
          extraConfig = {
            virtualisation.docker.enable = true;
            homelab.disko.device = "/dev/sda";
            # 200G root (default is 100G) — leaves headroom for the harmonia
            # binary cache + remote-builder role on top of docker/runner/yarr.
            homelab.disko.rootSize = "200G";
            sops.defaultSopsFile = ./nix/secrets/oldschool.sops.yaml;
            # harmonia's binary-cache signing key (public half committed at
            # nix/secrets/oldschool-harmonia-cache.pub); wired into
            # services.harmonia in the deploy-harmonia ticket.
            sops.secrets."harmonia-cache-key" = { };
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
        dns = mkHost "dns" {
          system = "aarch64-linux";
          modules = [ ./nix/hosts/dns.nix ];
        };
        rackpi5 = mkHost "rackpi5" {
          system = "aarch64-linux";
          modules = [ ./nix/hosts/rackpi5.nix ];
        };
        # rackpi5's default boot: stateless RAM image served over HTTP from
        # spore (nix/images/pi5-ram.nix); the rackpi5 config above is its
        # NFS-root fallback tier.
        rackpi5-ram = mkHost "rackpi5-ram" {
          system = "aarch64-linux";
          modules = [ ./nix/images/pi5-ram.nix ];
        };
        spore = mkHost "spore" {
          system = "aarch64-linux";
          modules = [ ./nix/hosts/spore.nix ];
        };

        # armv6l Pi Zero W: no native builder/cache exists for this arch, so
        # this is cross-compiled (nix/hardware/pi0.nix sets nixpkgs.crossSystem)
        # from whatever machine builds it -- in practice spore, hence the
        # aarch64-linux system below matching spore's native arch.
        radiopi0 = mkHost "radiopi0" {
          system = "aarch64-linux";
          modules = [ ./nix/hosts/radiopi0.nix ];
        };
        # Same board family as radiopi0 (Pi Zero W, armv6l), same cross-build
        # story -- but the physical device is currently unplugged, so this
        # config is derived from docs/pages/Hosts___blinkypi0.md and mirrors
        # radiopi0.nix rather than being verified against live hardware.
        blinkypi0 = mkHost "blinkypi0" {
          system = "aarch64-linux";
          modules = [ ./nix/hosts/blinkypi0.nix ];
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
    in
    {
      inherit nixosConfigurations;

      packages = {
        # sdImage derivations are pinned to aarch64-linux internally (each
        # Pi's nixosSystem is called with system = "aarch64-linux" above),
        # but they're only ever built by cross-compiling from the x86_64
        # WSL/laptop dev box via the qemu binfmt emulation in
        # nix/images/wsl.nix -- nobody builds these while logged into the Pi
        # itself. So they live under x86_64-linux, matching how `nix build
        # .#<host>` actually gets invoked, not under aarch64-linux.
        x86_64-linux = {
          cloudpi4 = nixosConfigurations.cloudpi4.config.system.build.sdImage;
          homepi4 = nixosConfigurations.homepi4.config.system.build.sdImage;
          weatherpi4 = nixosConfigurations.weatherpi4.config.system.build.sdImage;
          dns = nixosConfigurations.dns.config.system.build.sdImage;
          rackpi5 = nixosConfigurations.rackpi5.config.system.build.sdImage;
          rackpi5-ram = nixosConfigurations.rackpi5-ram.config.system.build.piBootImg;
          spore = nixosConfigurations.spore.config.system.build.sdImage;

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

        # radiopi0's armv6l target is cross-compiled, not natively built, so
        # its build platform (aarch64-linux, matching spore) actually needs to
        # be the system running `nix build`, unlike the x86_64-linux aliases
        # above.
        aarch64-linux = {
          radiopi0 = nixosConfigurations.radiopi0.config.system.build.sdImage;
          blinkypi0 = nixosConfigurations.blinkypi0.config.system.build.sdImage;
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
