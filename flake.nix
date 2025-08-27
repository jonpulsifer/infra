{
  description = "the homelab";

  inputs = {
    nixpkgs.url = "github:nixos/nixpkgs/nixos-25.05";
    nixos-hardware.url = "github:nixos/nixos-hardware";
    nixos-wsl = {
      url = "github:nix-community/NixOS-WSL/release-25.05";
      inputs.nixpkgs.follows = "nixpkgs";
    };

    home-manager = {
      url = "github:nix-community/home-manager/release-25.05";
      inputs.nixpkgs.follows = "nixpkgs";
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
        name: config:
        let
          system = if config.type == "rpi" then "aarch64-linux" else "x86_64-linux";
          type = if config.type == "image" then "image" else "host";
          modules = [ ./nix/${type}s/${name}.nix ] ++ (config.modules or [ ]);
        in
        nixosSystem {
          inherit system modules;
          specialArgs = { inherit name inputs; };
        };
    in
    rec {
      nixosConfigurations = builtins.mapAttrs mkSystem {
        # images (wsl, iso)
        wsl = {
          type = "image";
        };
        iso = {
          type = "image";
        };

        # kubernetes cluster (folly)
        nuc = { };
        optiplex = { };
        riptide = { };
        "800g2" = { };

        # kubernetes cluster (offsite)
        oldschool = { };
        retrofit = { };

        # raspberry pis
        cloudpi4 = {
          type = "rpi";
        };
        homepi4 = {
          type = "rpi";
        };
        screenpi4 = {
          type = "rpi";
        };
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
