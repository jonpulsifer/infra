{
  description = "jonpulsifer/dotfiles lol";

  inputs = {
    home-manager.url = "github:nix-community/home-manager/release-25.05";
    home-manager.inputs.nixpkgs.follows = "nixpkgs";
    nixpkgs.url = "github:nixos/nixpkgs/nixos-25.05";
    nixpkgs-unstable.url = "github:nixos/nixpkgs/nixpkgs-unstable";
    gh-aipr.url = "github:jonpulsifer/gh-aipr/add-nix-support";
    gh-aipr.inputs.nixpkgs.follows = "nixpkgs";
  };

  outputs =
    {
      self,
      home-manager,
      nixpkgs,
      nixpkgs-unstable,
      gh-aipr
    }:
    let
      forAllSystems = f: nixpkgs.lib.genAttrs [ "x86_64-linux" "aarch64-linux" "aarch64-darwin" ] f;

      # Single source of truth for our overlayed packages
      pkgsOverlay = final: prev: {
        kubectl = final.callPackage ./pkgs/kubectl.nix { };
        shell-utils = final.callPackage ./pkgs/shell-utils { };
      };

      pkgsForSystem = system: import nixpkgs {
        inherit system;
        config = {
          allowUnfree = true;
        };
        overlays = [
          (final: prev: {
            unstable = import nixpkgs-unstable {
              inherit system;
              config = prev.config;
            };
          })
          pkgsOverlay
          gh-aipr.overlays.default
        ];
      };

      mkHomeConfiguration =
        system: profile:
        home-manager.lib.homeManagerConfiguration ({
          modules = [ ./home/${profile}.nix ];
          pkgs = pkgsForSystem system;
        });

      homeConfigurations = {
        full = mkHomeConfiguration "x86_64-linux" "home";
        basic = mkHomeConfiguration "x86_64-linux" "basic";
        arm = mkHomeConfiguration "aarch64-linux" "basic";
        homebook = mkHomeConfiguration "aarch64-darwin" "homebook";
        work = mkHomeConfiguration "aarch64-darwin" "work";
      };
    in
    {
      # nix run .#basic
      packages = {
        x86_64-linux.default = homeConfigurations.full.activationPackage;
        x86_64-linux.basic = homeConfigurations.basic.activationPackage;
        aarch64-linux.default = homeConfigurations.arm.activationPackage;
        aarch64-darwin.default = homeConfigurations.work.activationPackage;
        aarch64-darwin.homebook = homeConfigurations.homebook.activationPackage;
      };

      # export home-manager modules for use in other systems
      home = {
        basic = import ./home/basic.nix;
        full = import ./home/home.nix;
      };

      overlays = {
        pkgs = pkgsOverlay;
      };

      devShells = forAllSystems (system:
        let pkgs = pkgsForSystem system; in {
          default = import ./shell.nix { inherit pkgs; };
        }
      );
      formatter = forAllSystems (system: nixpkgs.legacyPackages.${system}.nixfmt-rfc-style);
    };
}
