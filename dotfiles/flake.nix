{
  description = "jonpulsifer/dotfiles lol";

  inputs = {
    home-manager.url = "github:nix-community/home-manager/release-25.05";
    home-manager.inputs.nixpkgs.follows = "nixpkgs";
    nixpkgs.url = "github:nixos/nixpkgs/nixos-25.05";
    nixpkgs-unstable.url = "github:nixos/nixpkgs/nixpkgs-unstable";
    gh-aipr.url = "github:wannabehero/gh-aipr";
    gh-aipr.inputs.nixpkgs.follows = "nixpkgs";
  };

  outputs =
    {
      self,
      home-manager,
      nixpkgs,
      nixpkgs-unstable,
      gh-aipr,
    }:
    let
      forEachSystem = nixpkgs.lib.genAttrs [
        "x86_64-linux"
        "aarch64-linux"
        "aarch64-darwin"
      ];

      unstableOverlay =
        final: prev:
        let
          system =
            if final.stdenv ? hostPlatform then final.stdenv.hostPlatform.system else final.stdenv.system;
        in
        {
          unstable = import nixpkgs-unstable {
            inherit system;
            config = prev.config;
          };
        };

      overlays = [
        gh-aipr.overlays.pkgs
        unstableOverlay
        (import ./overlays.nix)
      ];

      forEachPkgs =
        f:
        forEachSystem (
          system:
          f (
            import nixpkgs {
              inherit system overlays;
              config = {
                allowUnfree = true;
              };
            }
          )
        );
      pkgsForSystem = forEachPkgs (pkgs: pkgs);

      mkHome = modules: pkgs: home-manager.lib.homeManagerConfiguration { inherit modules pkgs; };

      homeConfigurations = {
        full = mkHome [ ./home/home.nix ] pkgsForSystem."x86_64-linux";
        basic = mkHome [ ./home/basic.nix ] pkgsForSystem."x86_64-linux";
        arm = mkHome [ ./home/basic.nix ] pkgsForSystem."aarch64-linux";
        homebook = mkHome [ ./home/homebook.nix ] pkgsForSystem."aarch64-darwin";
        work = mkHome [ ./home/work.nix ] pkgsForSystem."aarch64-darwin";
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

      # expose full package sets so you can do
      # nix run .#legacyPackages.$system.<pkg>
      legacyPackages = pkgsForSystem;

      # export home-manager modules for use in other systems
      home = {
        basic = import ./home/basic.nix;
        full = import ./home/home.nix;
      };

      overlays = {
        pkgs = nixpkgs.lib.composeManyExtensions overlays;
      };

      devShells = forEachPkgs (pkgs: {
        default = import ./shell.nix { inherit pkgs; };
      });
      formatter = forEachSystem (system: nixpkgs.legacyPackages.${system}.nixfmt-rfc-style);
    };
}
