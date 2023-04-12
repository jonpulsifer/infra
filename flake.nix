{
  description = "the homelab";
  inputs = {
    dotfiles = {
      url = "github:jonpulsifer/dotfiles";
      inputs = {
        nixpkgs.follows = "nixpkgs";
        home-manager.follows = "home-manager";
      };
    };
    home-manager = { url = "github:nix-community/home-manager"; inputs.nixpkgs.follows = "nixpkgs"; };
    keys = { url = "https://github.com/jonpulsifer.keys"; flake = false; };
    nixos = { url = "github:nixos/nixpkgs/nixos-unstable"; };
    nixpkgs = { url = "github:nixos/nixpkgs/nixpkgs-unstable"; };
    nixos-hardware = { url = "github:nixos/nixos-hardware"; };
    wsl = { url = "github:nix-community/NixOS-WSL"; inputs.nixpkgs.follows = "nixpkgs"; };
  };
  outputs = { self, dotfiles, home-manager, keys, nixos, nixos-hardware, nixpkgs, wsl, ... }:
    let
      inherit (nixpkgs.lib) mkIf attrValues;

      kubernetesOnlyBuildKubeletOverlay = final: prev: {
        kubernetes = (prev.kubernetes.override {
          # buildGoModule = prev.buildGo119Module;
          components = [ "cmd/kubelet" ];
        }).overrideAttrs (_: rec {
          # version = "1.26.1";
          # src = prev.fetchFromGitHub {
          #   owner = "kubernetes";
          #   repo = "kubernetes";
          #   rev = "v${version}";
          #   sha256 = "sha256-bC2Q4jWBh27bqLGhvG4JcuHIAQmiGz5jDt9Me9qbVpk=";
          # };
        });
      };
      pkgs = {
        config.allowUnfree = true;
        overlays = [
          dotfiles.overlays.pkgs
          kubernetesOnlyBuildKubeletOverlay
        ];
      };

      nixosModules = [
        { nixpkgs = pkgs; }
        { home-manager.useUserPackages = true; }
        { home-manager.useGlobalPkgs = true; }
        home-manager.nixosModules.home-manager
        { home-manager.users.jawn = dotfiles.nixosModules.basic; }
        { system.configurationRevision = mkIf (self ? rev) self.rev; }
      ];

      mkRPi = hostName: modules:
        nixos.lib.nixosSystem {
          system = "aarch64-linux";
          modules = nixosModules ++ modules ++ [
            nixos-hardware.nixosModules.raspberry-pi-4
            ./systems/rpi/rpi.nix
            "${nixos}/nixos/modules/installer/sd-card/sd-image-aarch64.nix"
            { config.sdImage.compressImage = false; config.sdImage.firmwareSize = 512; }
            {
              nixpkgs.overlays = [
                # https://github.com/NixOS/nixpkgs/issues/154163
                (final: super: {
                  makeModulesClosure = x:
                    super.makeModulesClosure (x // { allowMissing = true; });
                })
                # (final: super: {
                #   ubootRaspberryPi4_64bit = super.ubootRaspberryPi4_64bit.override rec {
                #     version = "2023.01";
                #     src = super.fetchurl {
                #       url = "ftp://ftp.denx.de/pub/u-boot/u-boot-${version}.tar.bz2";
                #       hash = "sha256-aUI7rTgPiaCRZjbonm3L0uRRLVhDCNki0QOdHkMxlQ8=";
                #     };
                #   };
                # })
              ];
            }
          ];
          specialArgs = { inherit keys hostName; };
        };

      mkSystem = { hostName ? null, modules ? [ ] }:
        nixos.lib.nixosSystem {
          system = "x86_64-linux";
          modules = nixosModules ++ modules ++ [
            ./systems/nixos.nix
          ];
          specialArgs = { inherit keys hostName; };
        };
    in
    {
      formatter.x86_64-linux = nixpkgs.legacyPackages.x86_64-linux.nixpkgs-fmt;
      formatter.aarch64-darwin = nixpkgs.legacyPackages.aarch64-darwin.nixpkgs-fmt;
      devShells = {
        x86_64-linux.default = import ./shell.nix { pkgs = nixpkgs.legacyPackages.x86_64-linux; };
        aarch64-darwin.default = import ./shell.nix { pkgs = nixpkgs.legacyPackages.aarch64-darwin; };
      };

      nixosConfigurations = rec {
        # wsl on atomic
        atomic = nixos.lib.nixosSystem {
          modules = nixosModules ++ [
            wsl.nixosModules.wsl
            ./systems/wsl
            { home-manager.users.jawn = dotfiles.nixosModules.full; }
          ];
        };

        iso = mkSystem { modules = [ "${nixos}/nixos/modules/installer/cd-dvd/installation-cd-minimal.nix" ]; };
        cloudpi4 = mkRPi "cloudpi4" [ ];
        homepi4 = mkRPi "homepi4" [ ./systems/kubeadm.nix ];
        screenpi4 = mkRPi "screenpi4" [ ];

        nuc = mkSystem { modules = [ ./systems/nuc ./systems/kubeadm.nix ]; };
        "800g2-1" = mkSystem { hostName = "800g2-1"; modules = [ ./systems/800g2 ./systems/kubeadm.nix ]; };
        "800g2-2" = mkSystem { hostName = "800g2-2"; modules = [ ./systems/800g2 ./systems/kubeadm.nix ]; };
        "800g3-1" = mkSystem {
          hostName = "800g3-1";
          modules = [
            ./systems/800g3
            ./systems/kubeadm.nix
            # { networking.wireless.networks.lab = { hidden = true; }; }
          ];
        };
        "800g3-2" = mkSystem {
          hostName = "800g3-2";
          modules = [
            ./systems/800g3
            { networking.wireless.networks.Goggly.pskRaw = "c1e6a7dd93cd062b1b0e1f394b54f5a80ce63de04e9d9478f87312f8099df864"; }
          ];
        };
      };
    };
}
