{
  description = "jonpulsifer/dotfiles lol";
  
  inputs = {
    home-manager.url = "github:nix-community/home-manager";
    home-manager.inputs.nixpkgs.follows = "nixpkgs";
    nixpkgs.url = "github:nixos/nixpkgs/nixpkgs-unstable";
  };

  outputs =
    {
      self,
      home-manager,
      nixpkgs,
      ...
    }:
    let
      inherit (nixpkgs.lib) attrValues optionalAttrs;

      forallSystems = f: nixpkgs.lib.genAttrs [ "x86_64-linux" "aarch64-darwin" ] f;

      pkgs = {
        config = {
          allowUnfree = true;
        };
        overlays = attrValues self.overlays ++ [
          # Sub in x86 version of packages that don't build on Apple Silicon yet
          (
            final: prev:
            (optionalAttrs (prev.stdenv.system == "aarch64-darwin") {
              inherit (final.pkgs-x86) emacsMacport;
            })
          )
          (import ./pkgs)
        ];
      };

      mkHomeConfiguration =
        system: modules:
        home-manager.lib.homeManagerConfiguration ({
          inherit modules;
          pkgs = import nixpkgs {
            inherit system;
            inherit (pkgs) config overlays;
          };
        });
    in
    {
      devShells = forallSystems (system:
        let
          pkgs = nixpkgs.legacyPackages.${system};
        in {
          default = import ./shell.nix { inherit pkgs; };
        }
      );

      formatter = forallSystems (system:
        let
          pkgs = nixpkgs.legacyPackages.${system};
        in {
          default = pkgs.nixfmt-rfc-style;
        }
      );

      # Simplified home-manager configurations
      homeConfigurations = {
        full = mkHomeConfiguration "x86_64-linux" [ ./home/home.nix ];
        basic = mkHomeConfiguration "x86_64-linux" [ ./home/basic.nix ];
        arm = mkHomeConfiguration "aarch64-linux" [ ./home/basic.nix ];
        pixelbook = mkHomeConfiguration "x86_64-linux" [ ./home/pixelbook.nix ];
        work = mkHomeConfiguration "aarch64-darwin" [./home/work.nix ];
      };

      # nix run .#basic
      packages = {
        x86_64-linux = {
          default = self.homeConfigurations.full.activationPackage;
          basic = self.homeConfigurations.basic.activationPackage;
          pixelbook = self.homeConfigurations.pixelbook.activationPackage;
        };
        aarch64-linux.default = self.homeConfigurations.arm.activationPackage;
        aarch64-darwin.default = self.homeConfigurations.work.activationPackage;
      };

      # export home-manager modules for use in other systems
      home = {
        basic = import ./home/basic.nix;
        full = import ./home/home.nix;
      };

      overlays = {
        apple-silicon =
          _: prev:
          optionalAttrs (prev.stdenv.system == "aarch64-darwin") {
            # Add access to x86 packages if system is running Apple Silicon
            pkgs-x86 = import nixpkgs {
              system = "x86_64-darwin";
              inherit (pkgs) config;
            };
          };
        pkgs = (import ./pkgs);
      };
    };
}
