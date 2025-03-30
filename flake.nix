{
  description = "the homelab";

  inputs = {
    nixos.url = "github:nixos/nixpkgs/nixos-unstable";
    nixos-hardware.url = "github:nixos/nixos-hardware";
    nixos-wsl = {
      url = "github:nix-community/NixOS-WSL/main";
      inputs.nixpkgs.follows = "nixpkgs";
    };
    nixpkgs.url = "github:nixos/nixpkgs/nixpkgs-unstable";

    home-manager = {
      url = "github:nix-community/home-manager";
      follows = "dotfiles/home-manager";
      inputs.nixpkgs.follows = "nixpkgs";
    };

    hosts.url = "github:StevenBlack/hosts";

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
      nixos,
      nixos-hardware,
      nixos-wsl,
      keys,
      wannabekeys,
      ...
    }@inputs:
    let
      commonModules = [
        ./nix/nixos.nix
        {
          nixpkgs.overlays = [
            dotfiles.overlays.pkgs
            ddnsd.overlays.pkgs
          ];
          system.configurationRevision = nixos.lib.mkIf (self ? rev) self.rev;
        }
        home-manager.nixosModules.home-manager
        {
          home-manager.useUserPackages = true;
          home-manager.useGlobalPkgs = true;
          home-manager.users.jawn = dotfiles.home.basic;
        }
        ddnsd.nixosModules.default
      ];

      mkSystem =
        name: extraModules:
        nixos.lib.nixosSystem {
          system = "x86_64-linux";
          modules = [ ./systems/${name}.nix ] ++ commonModules ++ extraModules;
          specialArgs = { inherit keys wannabekeys name; };
        };

      mkRPi4 =
        name: extraModules:
        nixos.lib.nixosSystem {
          system = "aarch64-linux";
          modules =
            [ ./systems/${name}.nix ./systems/rpi.nix ]
            ++ [ nixos-hardware.nixosModules.raspberry-pi-4 ]
            ++ commonModules
            ++ extraModules
            ++ [
              "${nixos}/nixos/modules/installer/sd-card/sd-image-aarch64.nix"
              {
                config.sdImage.compressImage = true;
                config.sdImage.firmwareSize = 512;
              }
            ]
            ++ [
              {
                nixpkgs.overlays = [
                  # https://github.com/NixOS/nixpkgs/issues/154163
                  (final: super: {
                    makeModulesClosure = x: super.makeModulesClosure (x // { allowMissing = true; });
                  })
                ];
              }
            ];
          specialArgs = { inherit keys name; };
        };

      mkSystems = builtins.mapAttrs (
        name: modules: (if nixos.lib.strings.hasInfix "pi4" name then mkRPi4 else mkSystem) name modules
      );
    in
    rec {
      nixosConfigurations = mkSystems {
        # lab machines
        oldschool = [ ];
        retrofit = [ ];
        wsl = [ nixos-wsl.nixosModules.wsl ];

        # k8s cluster
        nuc = [ ];
        optiplex = [ ];
        riptide = [ ];
        "800g2" = [ ];

        # iso
        iso = [ "${nixos}/nixos/modules/installer/cd-dvd/installation-cd-minimal.nix" ];

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

      legacyPackages = nixos.lib.genAttrs [ "x86_64-linux" ] (
        system:
        import inputs.nixpkgs {
          inherit system;
          config.allowUnfree = true;
        }
      );

      formatter.x86_64-linux = legacyPackages.x86_64-linux.nixfmt-rfc-style;

      devShells = {
        x86_64-linux.default = import ./shell.nix {
          pkgs = legacyPackages.x86_64-linux;
        };
      };
    };
}
