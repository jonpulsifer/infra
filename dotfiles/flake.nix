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
      systems = [
        "x86_64-linux"
        "aarch64-linux"
        "aarch64-darwin"
      ];

      pkgsFor =
        system:
        import nixpkgs {
          inherit system overlays;
          config.allowUnfree = true;
        };

      pkgsBySystem = nixpkgs.lib.genAttrs systems pkgsFor;

      overlays = [
        gh-aipr.overlays.pkgs
        (final: prev: {
          # use as pkgs.unstable.<pkg> in modules
          unstable = import nixpkgs-unstable {
            inherit (prev) system config;
            overlays = [ ];
          };
          shell-utils = final.callPackage ./pkgs/shell-utils.nix { };
        })
      ];

      mkHome =
        system: modules:
        home-manager.lib.homeManagerConfiguration {
          inherit modules;
          pkgs = pkgsBySystem.${system};
        };

      homeConfigurations = {
        full = mkHome "x86_64-linux" [ ./home/home.nix ];
        basic = mkHome "x86_64-linux" [ ./home/basic.nix ];
        arm = mkHome "aarch64-linux" [ ./home/basic.nix ];
        homebook = mkHome "aarch64-darwin" [
          ./home/home.nix
          ./home/darwin.nix
        ];
        work = mkHome "aarch64-darwin" [ ./home/work.nix ];
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
      legacyPackages = pkgsBySystem;

      # export home-manager modules for use in other systems
      nixosModules = {
        default = import ./home/basic.nix;
        basic = import ./home/basic.nix;
        full = import ./home/home.nix;
      };

      overlays.default = nixpkgs.lib.composeManyExtensions overlays;

      devShells = nixpkgs.lib.genAttrs systems (system: {
        default = import ./shell.nix { pkgs = pkgsBySystem.${system}; };
      });

      formatter = nixpkgs.lib.genAttrs systems (system: pkgsBySystem.${system}.nixfmt-tree);
    };
}
