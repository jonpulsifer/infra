{
  description = "the homelab";
  inputs = {
    nixos.url = "github:nixos/nixpkgs/nixos-unstable";
    nixos-hardware.url = "github:nixos/nixos-hardware";
    nixpkgs.url = "github:nixos/nixpkgs/nixpkgs-unstable";
    nixos-wsl = { url = "github:nix-community/NixOS-WSL/main"; inputs.nixpkgs.follows = "nixpkgs"; };

    home-manager = { url = "github:nix-community/home-manager"; follows = "dotfiles/home-manager"; inputs.nixpkgs.follows = "nixpkgs"; };
    keys = { url = "https://github.com/jonpulsifer.keys"; flake = false; };
    wannabekeys = { url = "https://github.com/wannabehero.keys"; flake = false; };
    dotfiles = { url = "github:jonpulsifer/dotfiles"; inputs.nixpkgs.follows = "nixpkgs"; };
    ddnsd = { url = "github:jonpulsifer/ddnsd"; inputs.nixpkgs.follows = "nixpkgs"; };
  };
  outputs = { self, ddnsd, dotfiles, home-manager, keys, wannabekeys, nixos, nixos-hardware, nixos-wsl, ... }@inputs:
    let
      inherit (nixos.lib) mkIf optionals attrValues genAttrs nixosSystem strings;

      # common modules for all systems
      common = [
        {
          nixpkgs.overlays = [ dotfiles.overlays.pkgs ddnsd.overlays.pkgs ];
          system.configurationRevision = mkIf (self ? rev) self.rev;
        }
        {
          home-manager.useUserPackages = true;
          home-manager.useGlobalPkgs = true;
          home-manager.users.jawn = dotfiles.home.basic;
        }
        home-manager.nixosModules.home-manager
        ddnsd.nixosModules.default
        ./systems/nixos.nix
      ];

      # k8s cluster modules
      k8sControlPlane = [ ./systems/modules/k8s/control-plane.nix ];
      k8sWorker = [ ./systems/modules/k8s/worker.nix ];

      mkSystem = name: extra: nixosSystem {
        system = "x86_64-linux";
        modules = common ++ extra ++ [{ config.networking.hostName = name; }];
        specialArgs = { inherit keys wannabekeys; };
      };

      mkRPi4 = name: extra: nixos.lib.nixosSystem {
        system = "aarch64-linux";
        modules = common ++ extra
          ++ [ nixos-hardware.nixosModules.raspberry-pi-4 ]
          ++ [{ config.networking.hostName = name; }]
          ++ [ ./systems/rpi.nix ]
          ++ [ "${nixos}/nixos/modules/installer/sd-card/sd-image-aarch64.nix" { config.sdImage.compressImage = false; config.sdImage.firmwareSize = 512; } ]
          ++ [{
          nixpkgs.overlays = [
            # https://github.com/NixOS/nixpkgs/issues/154163
            (final: super: {
              makeModulesClosure = x:
                super.makeModulesClosure (x // { allowMissing = true; });
            })
          ];
        }];
        specialArgs = { inherit keys; };
      };

      mkSystems = builtins.mapAttrs
        (name: modules:
          if strings.hasInfix "pi4" name then
            mkRPi4 name modules
          else
            mkSystem name modules
        );
    in
    rec {
      nixosConfigurations = mkSystems
        {
          # lab machines
          oldschool = [ ./systems/oldschool.nix ];
          retrofit = [ ./systems/retrofit.nix ];
          wsl = [
            nixos-wsl.nixosModules.wsl
            ./systems/wsl.nix
          ];

          # k8s cluster
          nuc = k8sControlPlane;
          optiplex = k8sWorker;
          riptide = k8sWorker;
          "800g2" = k8sWorker;

          # raspberry pis
          rpi4 = [ ];
          homepi4 = [{ services.kiosk.enable = true; }];
          screenpi4 = [{ services.kiosk.enable = true; }];

          # iso
          iso = [
            "${nixos}/nixos/modules/installer/cd-dvd/installation-cd-minimal.nix"
            ./systems/iso.nix
          ];
        };

      packages = {
        x86_64-linux = {
          iso = nixosConfigurations.iso.config.system.build.isoImage;
          wsl = nixosConfigurations.wsl.config.system.build.tarballBuilder;
        };
        aarch64-linux = { rpi4 = nixosConfigurations.rpi4.config.system.build.sdImage; };
      };

      legacyPackages = genAttrs [ "x86_64-linux" ] (system:
        import inputs.nixpkgs {
          inherit system;
          config.allowUnfree = true;
        }
      );

      formatter.x86_64-linux = legacyPackages.x86_64-linux.nixpkgs-fmt;

      devShells = {
        x86_64-linux.default = import ./shell.nix {
          pkgs = legacyPackages.x86_64-linux;
        };
      };
    };
}
