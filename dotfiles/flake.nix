{
  description = "jonpulsifer/dotfiles lol"; # managed with ❤️ and nix

  inputs = {
    nixpkgs.url = "github:nixos/nixpkgs/nixpkgs-unstable";
    home-manager.url = "github:nix-community/home-manager/master";
    home-manager.inputs.nixpkgs.follows = "nixpkgs";
    llm-agents.url = "github:numtide/llm-agents.nix";
    llm-agents.inputs.nixpkgs.follows = "nixpkgs";
  };

  nixConfig = {
    extra-substituters = [ "https://cache.numtide.com" ];
    extra-trusted-public-keys = [ "niks3.numtide.com-1:DTx8wZduET09hRmMtKdQDxNNthLQETkc/yaX7M4qK0g=" ];
  };

  outputs =
    {
      self,
      home-manager,
      nixpkgs,
      llm-agents,
    }:
    let
      systems = [
        "x86_64-linux"
        "aarch64-linux"
        "aarch64-darwin"
      ];

      overlays = [
        llm-agents.overlays.default
        (final: prev: {
          shell-utils = final.callPackage ./pkgs/shell-utils.nix { };
        })
      ];

      pkgsFor =
        system:
        import nixpkgs {
          inherit system overlays;
          config.allowUnfree = true;
        };

      pkgsBySystem = nixpkgs.lib.genAttrs systems pkgsFor;

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
      packages = {
        x86_64-linux.default = homeConfigurations.full.activationPackage;
        x86_64-linux.basic = homeConfigurations.basic.activationPackage;
        aarch64-linux.default = homeConfigurations.arm.activationPackage;
        aarch64-darwin.default = homeConfigurations.work.activationPackage;
        aarch64-darwin.homebook = homeConfigurations.homebook.activationPackage;
      };

      legacyPackages = pkgsBySystem;

      # home-manager modules, not NixOS modules
      homeModules = {
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
