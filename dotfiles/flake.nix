{
  description = "jonpulsifer/dotfiles lol";

  inputs = {
    home-manager.url = "github:nix-community/home-manager/release-24.11";
    home-manager.inputs.nixpkgs.follows = "nixpkgs";
    nixpkgs.url = "github:nixos/nixpkgs/nixos-24.11";
    nixpkgs-unstable.url = "github:nixos/nixpkgs/nixpkgs-unstable";
  };

  outputs =
    {
      self,
      home-manager,
      nixpkgs,
      nixpkgs-unstable,
      ...
    }:
    let
      inherit (nixpkgs.lib) attrValues optionalAttrs;

      forAllSystems = f: nixpkgs.lib.genAttrs [ "x86_64-linux" "aarch64-linux" "aarch64-darwin" ] f;
      
      pkgsForSystem =
        system:
        import nixpkgs {
          inherit system;
          config = {
            allowUnfree = true;
          };
          overlays = [
            # Sub in x86 version of packages that don't build on Apple Silicon yet
            (
              final: prev:
              (optionalAttrs (prev.stdenv.system == "aarch64-darwin") {
                inherit (final.pkgs-x86) emacsMacport;
              })
            )
            # Add unstable packages as an overlay
            (final: prev: {
              unstable = import nixpkgs-unstable {
                inherit system;
                config = prev.config;
              };
            })
            # Custom packages overlay
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
        homebook = mkHomeConfiguration "aarch64-darwin" "homebook";
        pixelbook = mkHomeConfiguration "x86_64-linux" "pixelbook";
        work = mkHomeConfiguration "aarch64-darwin" "work";
      };
    in
    {
      # nix run .#basic
      packages = {
        x86_64-linux.default = homeConfigurations.full.activationPackage;
        x86_64-linux.basic = homeConfigurations.basic.activationPackage;
        x86_64-linux.pixelbook = homeConfigurations.pixelbook.activationPackage;
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
        apple-silicon =
          _: prev:
          optionalAttrs (prev.stdenv.system == "aarch64-darwin") {
            # Add access to x86 packages if system is running Apple Silicon
            pkgs-x86 = pkgsForSystem "x86_64-darwin";
          };
        pkgs = import ./pkgs;
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
