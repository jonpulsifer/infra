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
    wsl = { url = "github:nix-community/NixOS-WSL"; inputs.nixpkgs.follows = "nixpkgs"; };
  };
  outputs = { self, dotfiles, home-manager, keys, nixos, nixpkgs, wsl, ... }:
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

      mkSystem = { hostName ? "nixos", modules ? [ ] }: nixos.lib.nixosSystem {
        system = "x86_64-linux";
        modules = [
          ./systems/nixos.nix
        ] ++ nixosModules ++ modules;
        specialArgs = { inherit keys hostName; };
      };
    in
    {
      formatter.x86_64-linux = nixpkgs.legacyPackages."x86_64-linux".nixpkgs-fmt;
      devShells.x86_64-linux.default = import ./shell.nix { pkgs = nixpkgs.legacyPackages.x86_64-linux; };
      nixosConfigurations = rec {
        # wsl on atomic
        atomic = nixos.lib.nixosSystem {
          modules = nixosModules ++ [
            wsl.nixosModules.wsl
            ./systems/wsl
            { home-manager.users.jawn = dotfiles.nixosModules.full; }
          ];
          specialArgs = {
            isGui = false;
          };
        };

        iso = mkSystem { modules = [ "${nixos}/nixos/modules/installer/cd-dvd/installation-cd-minimal.nix" ]; };
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
