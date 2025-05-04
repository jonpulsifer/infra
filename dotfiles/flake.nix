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

      forAllSystems = f: nixpkgs.lib.genAttrs [ "x86_64-linux" "aarch64-linux" "aarch64-darwin" ] f;
      pkgsForSystem =
        system:
        import nixpkgs {
          inherit system;
          inherit (pkgsConfig) config overlays;
        };
      pkgsConfig = {
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
        system: profile:
        home-manager.lib.homeManagerConfiguration ({
          modules = [ ./home/${profile}.nix ];
          pkgs = pkgsForSystem system;
        });

      homeConfigurations = {
        full = mkHomeConfiguration "x86_64-linux" "home";
        basic = mkHomeConfiguration "x86_64-linux" "basic";
        arm = mkHomeConfiguration "aarch64-linux" "basic";
        pixelbook = mkHomeConfiguration "x86_64-linux" "pixelbook";
        work = mkHomeConfiguration "aarch64-darwin" "work";
      };
    in
    {
      # nix run .#basic
      packages = {
        x86_64-linux = {
          default = homeConfigurations.full.activationPackage;
          basic = homeConfigurations.basic.activationPackage;
          pixelbook = homeConfigurations.pixelbook.activationPackage;
        };
        aarch64-linux.default = homeConfigurations.arm.activationPackage;
        aarch64-darwin.default = homeConfigurations.work.activationPackage;
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
            pkgs-x86 = pkgsForSystem "x86_64-darwin";
          };
      };
      
      devShells = forAllSystems (
        system:
        let
          pkgs = pkgsForSystem system;
        in
        {
          default = import ./shell.nix { inherit pkgs; };
        }
      );
      formatter = forAllSystems (system: nixpkgs.legacyPackages.${system}.nixfmt-rfc-style);
    };
}
