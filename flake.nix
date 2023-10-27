{
  description = "the homelab";
  inputs = {
    dotfiles = { url = "github:jonpulsifer/dotfiles"; inputs.nixpkgs.follows = "nixpkgs"; };
    home-manager = { url = "github:nix-community/home-manager"; follows = "dotfiles/home-manager"; inputs.nixpkgs.follows = "nixpkgs"; };
    keys = { url = "https://github.com/jonpulsifer.keys"; flake = false; };
    nixos = { url = "github:nixos/nixpkgs/nixos-unstable"; };
    nixos-hardware = { url = "github:nixos/nixos-hardware"; };
    nixpkgs = { url = "github:nixos/nixpkgs/nixpkgs-unstable"; };
    wsl = { url = "github:nix-community/NixOS-WSL"; inputs.nixpkgs.follows = "nixpkgs"; };
  };
  outputs = { self, dotfiles, home-manager, keys, nixos, nixos-hardware, wsl, ... }@inputs:
    let
      inherit (nixos.lib) mkIf attrValues;

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
              ];
            }
          ];
          specialArgs = { inherit keys hostName; needsRoutes = true; };
        };

      mkSystem = { hostName ? null, modules ? [ ] }:
        nixos.lib.nixosSystem {
          system = "x86_64-linux";
          modules = nixosModules ++ modules ++ [ ./systems/nixos.nix ];
          specialArgs = { inherit keys hostName; needsRoutes = false; };
        };

      mkEliteDesk = hostName: modules:
        mkSystem { inherit hostName; modules = [ ./systems/elitedesks ] ++ modules; };
    in
    rec {
      legacyPackages = nixos.lib.genAttrs [ "x86_64-linux" ] (system:
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

      nixosConfigurations = rec {
        # wsl on atomic
        atomic = mkSystem {
          modules = [
            wsl.nixosModules.wsl
            ./systems/wsl
            { home-manager.users.jawn = dotfiles.home.full; }
          ];
        };

        iso = mkSystem { modules = [ "${nixos}/nixos/modules/installer/cd-dvd/installation-cd-minimal.nix" ]; };
        nuc = mkSystem { modules = [ ./systems/nuc ./systems/kubeadm.nix ]; };
        htpc = mkSystem { modules = [ ./systems/htpc ]; };

        cloudpi4 = mkRPi "cloudpi4" [ ];
        homepi4 = mkRPi "homepi4" [ ./systems/rpi/modules/kiosk.nix ];
        screenpi4 = mkRPi "screenpi4" [ ./systems/rpi/modules/kiosk.nix ];

        "800g2" = mkEliteDesk "800g2" [ ./systems/kubeadm.nix ];
        "800g2-1" = mkEliteDesk "800g2-1" [ ./systems/kubeadm.nix ];
        "800g2-2" = mkEliteDesk "800g2-2" [ ./systems/kubeadm.nix ];
        "800g3-1" = mkEliteDesk "800g3-1" [
          ./systems/kubeadm.nix
          # { networking.wireless.networks.lab = { hidden = true; }; }
        ];
        "800g3-2" = mkEliteDesk "800g3-2" [
          { networking.wireless.networks.Goggly.pskRaw = "c1e6a7dd93cd062b1b0e1f394b54f5a80ce63de04e9d9478f87312f8099df864"; }
        ];
      };
    };
}
