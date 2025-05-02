{
  description = "jonpulsifer/dotfiles lol";
  inputs = {
    darwin = {
      url = "github:LnL7/nix-darwin";
      inputs.nixpkgs.follows = "nixpkgs";
    };
    home-manager = {
      url = "github:nix-community/home-manager";
      inputs.nixpkgs.follows = "nixpkgs";
    };
    nixpkgs.url = "github:nixos/nixpkgs/nixpkgs-unstable";
  };

  outputs =
    {
      self,
      darwin,
      home-manager,
      nixpkgs,
      ...
    }:
    let
      inherit (nixpkgs.lib) attrValues optionalAttrs;
      inherit (darwin.lib) darwinSystem;

      pkgs = {
        config = {
          allowUnfree = true;
        };
        overlays = attrValues self.overlays ++ [
          # Sub in x86 version of packages that don't build on Apple Silicon yet
          (
            final: prev:
            (optionalAttrs (prev.stdenv.system == "aarch64-darwin") {
              inherit (final.pkgs-x86) emacsMacport nerdctl;
            })
          )
          # (import ./overlays/pnpm) # 2024-06-28 we don't use nodePackages.pnpm anymore
          # (import ./overlays/httpie) # 2022-12-18 httpie tests are broken
          # (import ./overlays/opa) # 2023-02-04 opa tests are broken
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

      common = [
        { nixpkgs = pkgs; }
        {
          home-manager.useUserPackages = true;
          home-manager.useGlobalPkgs = true;
          home-manager.backupFileExtension = ".bak";
        }
        home-manager.darwinModules.home-manager
        ./systems/macos.nix
      ];

      # System-specific settings
      darwinCommon = common ++ [ { home-manager.users.jawn = import ./home/home.nix; } ];
    in
    {
      devShells.x86_64-linux.default = import ./shell.nix { pkgs = nixpkgs.legacyPackages.x86_64-linux; };
      devShells.aarch64-darwin.default = import ./shell.nix {
        pkgs = nixpkgs.legacyPackages.aarch64-darwin;
      };

      formatter.x86_64-linux = nixpkgs.legacyPackages.x86_64-linux.nixfmt-rfc-style;
      formatter.aarch64-darwin = nixpkgs.legacyPackages.aarch64-darwin.nixfmt-rfc-style;

      # Simplified home-manager configurations
      homeConfigurations = {
        full = mkHomeConfiguration "x86_64-linux" [ ./home/home.nix ];
        basic = mkHomeConfiguration "x86_64-linux" [ ./home/basic.nix ];
        arm = mkHomeConfiguration "aarch64-linux" [ ./home/basic.nix ];
        pixelbook = mkHomeConfiguration "x86_64-linux" [ ./home/pixelbook.nix ];
        worktest = mkHomeConfiguration "aarch64-darwin" [./home/work.nix ];
      };

      darwinConfigurations = rec {
        Craftbook-Air = darwinSystem {
          system = "aarch64-darwin";
          modules = darwinCommon ++ [ ./systems/air.nix ];
        };
        air = Craftbook-Air; # alias

        mini = darwinSystem {
          system = "x86_64-darwin";
          modules = darwinCommon ++ [ ./systems/mini.nix ];
        };

        hackbookpro = darwinSystem {
          system = "aarch64-darwin";
          modules = common ++ [ { home-manager.users.jawn = import ./home/work.nix; } ];
        };
        JRFHWF22CL = hackbookpro; # alias
      };

      # nix run .#basic
      packages = {
        x86_64-linux = {
          default = self.homeConfigurations.full.activationPackage;
          basic = self.homeConfigurations.basic.activationPackage;
          pixelbook = self.homeConfigurations.pixelbook.activationPackage;
        };
        aarch64-linux.default = self.homeConfigurations.arm.activationPackage;
        aarch64-darwin.default = self.homeConfigurations.worktest.activationPackage;
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
