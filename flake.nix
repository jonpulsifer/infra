{
  description = "the homelab";

  inputs = {
    nixpkgs.url = "github:nixos/nixpkgs/nixos-25.05";
    nixos-hardware.url = "github:nixos/nixos-hardware";
    nixos-wsl = {
      url = "github:nix-community/NixOS-WSL/release-25.05";
      inputs.nixpkgs.follows = "nixpkgs";
    };
    unstable.url = "github:nixos/nixpkgs/nixos-unstable";

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
      unstable,
      ...
    }@inputs:
    let
      inherit (nixpkgs.lib) genAttrs nixosSystem;
      forAllSystems = f: genAttrs [ "x86_64-linux" "aarch64-linux" ] (system: f system);

      mkSystem =
        name: config:
        let
          system = config.system or "x86_64-linux";
          moduleDir = config.profile or "hosts";
          modules = [ ./nix/${moduleDir}/${name}.nix ] ++ (config.modules or [ ]);
          tags = config.tags or [ ];
          nixosSystem = (name == "rackpi5" ? unstable.lib.nixosSystem : nixosSystem);
        in
        nixosSystem {
          inherit system modules;
          specialArgs = { inherit name inputs tags; };
        };

      hostsSpec = {
        # kubernetes cluster (folly)
        nuc = { tags = [ "folly" ]; };
        optiplex = { tags = [ "folly" ]; };
        riptide = { tags = [ "folly" ]; };
        "800g2" = { tags = [ "folly" ]; };

        # kubernetes cluster (offsite)
        oldschool = { tags = [ "offsite" ]; };
        retrofit = { tags = [ "offsite" ]; };

        # raspberry pis
        cloudpi4 = {
          system = "aarch64-linux";
        };
        homepi4 = {
          system = "aarch64-linux";
        };
        weatherpi4 = {
          system = "aarch64-linux";
        };
        rackpi5 = {
          system = "aarch64-linux";
        };

        # google cloud
        oldboy = { tags = [ "gcp" ]; };

        # images
        wsl = {
          profile = "images";
        };
        iso = {
          profile = "images";
        };
        gce = {
          profile = "images";
        };
      };
    in
    rec {
      nixosConfigurations = builtins.mapAttrs mkSystem hostsSpec;

      packages = {
        x86_64-linux = {
          iso = nixosConfigurations.iso.config.system.build.isoImage;
          wsl = nixosConfigurations.wsl.config.system.build.tarballBuilder;
          gce = nixosConfigurations.gce.config.system.build.googleComputeImage;
          oldboy = nixosConfigurations.oldboy.config.system.build.googleComputeImage;
        };
        aarch64-linux = {
          cloudpi4 = nixosConfigurations.cloudpi4.config.system.build.sdImage;
          homepi4 = nixosConfigurations.homepi4.config.system.build.sdImage;
          weatherpi4 = nixosConfigurations.weatherpi4.config.system.build.sdImage;
          rackpi5 = nixosConfigurations.rackpi5.config.system.build.sdImage;
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

      apps = forAllSystems (system:
        let
          pkgs = legacyPackages.${system};
          appsLib = import ./nix/lib/apps.nix;
        in
        appsLib.mkApps {
          inherit pkgs hostsSpec nixosConfigurations;
        }
      );
    };
}
