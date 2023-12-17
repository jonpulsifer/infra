{
  description = "the homelab";
  inputs = {
    dotfiles = { url = "github:jonpulsifer/dotfiles"; inputs.nixpkgs.follows = "nixpkgs"; };
    home-manager = { url = "github:nix-community/home-manager"; follows = "dotfiles/home-manager"; inputs.nixpkgs.follows = "nixpkgs"; };
    keys = { url = "https://github.com/jonpulsifer.keys"; flake = false; };
    nixos = { url = "github:nixos/nixpkgs/nixos-unstable"; };
    nixos-hardware = { url = "github:nixos/nixos-hardware"; };
    nixpkgs = { url = "github:nixos/nixpkgs/nixpkgs-unstable"; };
  };
  outputs = { self, dotfiles, home-manager, keys, nixos, nixos-hardware, ... }@inputs:
    let
      inherit (nixos.lib) mkIf optionals attrValues genAttrs;

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
        { home-manager.users.jawn = dotfiles.home.basic; }
        { system.configurationRevision = mkIf (self ? rev) self.rev; }
        ./systems/nixos.nix
      ];

      mkRPi = host: { kiosk ? false, extraModules ? [ ], ... }:
        nixos.lib.nixosSystem {
          system = "aarch64-linux";
          modules = nixosModules
            ++ [ nixos-hardware.nixosModules.raspberry-pi-4 ]
            ++ [{ config.networking.hostName = host; }]
            ++ [ ./systems/rpi/rpi.nix ]
            ++ optionals kiosk [ ./systems/rpi/modules/kiosk.nix ]
            ++ extraModules
            ++ [ "${nixos}/nixos/modules/installer/sd-card/sd-image-aarch64.nix" { config.sdImage.compressImage = false; config.sdImage.firmwareSize = 512; } ]
            ++ [{
            nixpkgs.overlays = [
              # https://github.com/NixOS/nixpkgs/issues/154163
              (final: super: {
                makeModulesClosure = x:
                  super.makeModulesClosure (x // { allowMissing = true; });
              })
            ];
          }];
          specialArgs = { inherit keys; needsRoutes = true; };
        };

      mkSystem = host: { sff ? true, k8s ? true, extraModules ? [ ] }:
        nixos.lib.nixosSystem {
          system = "x86_64-linux";
          modules = nixosModules
            ++ [{ config.networking.hostName = host; }]
            ++ optionals sff [ ./systems/sff ]
            ++ optionals k8s [ ./systems/kubeadm.nix ]
            ++ extraModules;
          specialArgs = { inherit keys; needsRoutes = false; };
        };

    in
    rec {
      nixosConfigurations = builtins.mapAttrs
        (host: config:
          if config.rpi or false then
            mkRPi host config
          else
            mkSystem host config
        )
        {
          # lab machines
          oldschool = {
            k8s = false;
            extraModules = [
              ./systems/github-runner.nix
              {
                networking.wireless.enable = true;
                networking.wireless.networks.Goggly.pskRaw = "c1e6a7dd93cd062b1b0e1f394b54f5a80ce63de04e9d9478f87312f8099df864";
                services.tailscale.useRoutingFeatures = [ "server" ];
              }
            ];
          };
          optiplex = { };
          "800g2" = { };
          "800g2-2" = { };

          # raspberry pis
          cloudpi4 = { rpi = true; };
          homepi4 = { rpi = true; kiosk = true; };
          screenpi4 = { rpi = true; kiosk = true; };

          # iso
          iso = {
            extraModules = [
              "${nixos}/nixos/modules/installer/cd-dvd/installation-cd-minimal.nix"
              ./systems/iso.nix
            ];
          };
        };

      legacyPackages = genAttrs [ "x86_64-linux" ] (system:
        import inputs.nixpkgs {
          inherit system;
          config.allowUnfree = true;
        }
      );
      formatter.x86_64-linux = legacyPackages.x86_64-linux.nixpkgs-fmt;

      devShells = {
        x86_64-linux.default = import ./shell.nix {
          pkgs = legacyPackages.x86_64-linux;
        };
      };
    };
}
