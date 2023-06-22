{
  description = "jonpulsifer/dotfiles lol";
  inputs = {
    darwin = { url = "github:LnL7/nix-darwin"; inputs.nixpkgs.follows = "nixpkgs"; };
    home-manager = { url = "github:nix-community/home-manager"; inputs.nixpkgs.follows = "nixpkgs"; };
    nixpkgs = { url = "github:nixos/nixpkgs/nixpkgs-unstable"; };
  };

  outputs = { self, darwin, home-manager, nixpkgs, ... }:
    let
      inherit (nixpkgs.lib) attrValues optionalAttrs;
      inherit (darwin.lib) darwinSystem;

      pkgs = {
        config = { allowUnfree = true; };
        overlays = attrValues self.overlays ++ [
          # Sub in x86 version of packages that don't build on Apple Silicon yet
          (final: prev:
            (optionalAttrs (prev.stdenv.system == "aarch64-darwin") {
              inherit (final.pkgs-x86) emacsMacport nerdctl;
            }))
          # (import ./overlays/httpie) # 2022-12-18 httpie tests are broken
          # (import ./overlays/opa) # 2023-02-04 opa tests are broken
          (import ./pkgs)
        ];
      };

      mkHomeConfiguration = system: modules:
        home-manager.lib.homeManagerConfiguration ({
          inherit modules;
          pkgs = import nixpkgs {
            inherit system;
            inherit (pkgs) config overlays;
          };
        });

      common = [
        { nixpkgs = pkgs; }
        { home-manager.useUserPackages = true; }
        { home-manager.useGlobalPkgs = true; }
        home-manager.darwinModules.home-manager
        ./systems/macos.nix
      ];
    in
    {
      devShells.x86_64-linux.default = import ./shell.nix { pkgs = nixpkgs.legacyPackages.x86_64-linux; };
      devShells.aarch64-darwin.default = import ./shell.nix { pkgs = nixpkgs.legacyPackages.aarch64-darwin; };

      formatter.x86_64-linux = nixpkgs.legacyPackages.x86_64-linux.nixpkgs-fmt;
      formatter.aarch64-darwin = nixpkgs.legacyPackages.aarch64-darwin.nixpkgs-fmt;

      # home-manager profiles, for things like nix on ubuntu
      homeConfigurations = {
        full = mkHomeConfiguration "x86_64-linux" [ ./home/home.nix ];
        basic = mkHomeConfiguration "x86_64-linux" [ ./home/basic.nix ];
        arm = mkHomeConfiguration "aarch64-linux" [ ./home/basic.nix ];
      };

      # nix run .#basic
      packages = {
        x86_64-linux = {
          default = self.homeConfigurations.full.activationPackage;
          basic = self.homeConfigurations.basic.activationPackage;
        };
        aarch64-linux.default = self.homeConfigurations.arm.activationPackage;
      };

      # nix-darwin
      darwinConfigurations = rec {
        mini = darwinSystem {
          system = "x86_64-darwin";
          modules = common ++ [
            ./systems/mini.nix
            { home-manager.users.jawn = import ./home/home.nix; }
          ];
        };

        hackbookpro = darwinSystem {
          system = "aarch64-darwin";
          modules = common ++ [
            ./systems/macbookpro.nix
            { home-manager.users.jawn = import ./home/work.nix; }
          ];
        };
        JTWV573RHQ = hackbookpro;
      };

      # export home-manager modules for use in other systems
      home = {
        basic = import ./home/basic.nix;
        full = import ./home/home.nix;
      };

      overlays = {
        apple-silicon = _: prev:
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
