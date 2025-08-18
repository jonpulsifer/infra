{
  description = "the homelab";

  inputs = {
    nixpkgs.url = "github:nixos/nixpkgs/nixos-25.05";
    nixos-hardware.url = "github:nixos/nixos-hardware";
    nixos-wsl = {
      url = "github:nix-community/NixOS-WSL/main";
      inputs.nixpkgs.follows = "nixpkgs";
    };

    home-manager = {
      url = "github:nix-community/home-manager";
      follows = "dotfiles/home-manager";
    };

    hosts = {
      url = "github:StevenBlack/hosts";
      inputs.nixpkgs.follows = "nixpkgs";
    };

    # my repositories
    dotfiles = {
      url = "github:jonpulsifer/dotfiles";
      inputs.nixpkgs.follows = "nixpkgs";
    };
    ddnsd = {
      url = "github:jonpulsifer/ddnsd";
      inputs.nixpkgs.follows = "nixpkgs";
    };

    # ssh keys
    keys = {
      url = "https://github.com/jonpulsifer.keys";
      flake = false;
    };
    wannabekeys = {
      url = "https://github.com/wannabehero.keys";
      flake = false;
    };
  };
  outputs =
    {
      self,
      ddnsd,
      dotfiles,
      home-manager,
      hosts,
      nixpkgs,
      nixos-hardware,
      nixos-wsl,
      keys,
      wannabekeys,
      ...
    }@inputs:
    let
      inherit (nixpkgs.lib) genAttrs strings nixosSystem;
      forAllSystems = f: genAttrs [ "x86_64-linux" "aarch64-linux" ] (system: f system);

      mkSystem =
        name: extraModules:
        nixosSystem {
          system = "x86_64-linux";
          modules = [
            ./nix/nixos.nix
            ./systems/${name}.nix
          ]
          ++ extraModules;
          specialArgs = { inherit name inputs; };
        };

      mkRPi4 =
        name: extraModules:
        nixosSystem {
          system = "aarch64-linux";
          modules = [
            ./nix/rpi.nix
            ./systems/${name}.nix
          ]
          ++ extraModules;
          specialArgs = { inherit name inputs; };
        };

      mkSystems = builtins.mapAttrs (
        name: modules: (if strings.hasInfix "pi4" name then mkRPi4 else mkSystem) name modules
      );
    in
    rec {
      nixosConfigurations = mkSystems {
        # lab machines
        wsl = [ nixos-wsl.nixosModules.default ];

        # k8s cluster
        nuc = [ ];
        optiplex = [ ];
        riptide = [ ];
        "800g2" = [ ];

        # offsite
        oldschool = [ ];
        retrofit = [ ];

        # iso
        iso = [ "${nixpkgs}/nixos/modules/installer/cd-dvd/installation-cd-minimal.nix" ];

        # raspberry pis
        cloudpi4 = [ hosts.nixosModule ];
        homepi4 = [ ];
        screenpi4 = [ ];
      };

      packages = {
        x86_64-linux = {
          iso = nixosConfigurations.iso.config.system.build.isoImage;
          wsl = nixosConfigurations.wsl.config.system.build.tarballBuilder;
        };
        aarch64-linux = {
          cloudpi4 = nixosConfigurations.cloudpi4.config.system.build.sdImage;
          homepi4 = nixosConfigurations.homepi4.config.system.build.sdImage;
          screenpi4 = nixosConfigurations.screenpi4.config.system.build.sdImage;
        };
      };

      legacyPackages = nixpkgs.lib.genAttrs [ "x86_64-linux" "aarch64-linux" ] (
        system:
        import nixpkgs {
          inherit system;
          config.allowUnfree = true;
        }
      );

      formatter = forAllSystems (system: legacyPackages.${system}.nixfmt-tree);

      devShells = forAllSystems (system: {
        default = import ./shell.nix {
          pkgs = legacyPackages.${system};
        };
      });
    };
}
