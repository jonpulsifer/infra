{
  description = "the homelab";

  nixConfig = {
    accept-flake-config = true;
    extra-substituters = [
      "https://nixos-raspberrypi.cachix.org"
      "https://nix-community.cachix.org"
    ];
    extra-trusted-public-keys = [
      "nixos-raspberrypi.cachix.org-1:4iMO9LXa8BqhU+Rpg6LQKiGa2lsNh/j2oiYLNOQ5sPI="
      "nix-community.cachix.org-1:mB9FSh9qf2dCimDSUo8Zy7bkq5CX+/rkCWyvRCYg3Fs="
    ];
  };

  inputs = {
    nixpkgs.url = "github:nixos/nixpkgs/nixos-26.05";
    nixos-hardware.url = "github:nixos/nixos-hardware";
    nixos-raspberrypi.url = "github:nvmd/nixos-raspberrypi/main";
    nixos-wsl = {
      url = "github:nix-community/NixOS-WSL/release-26.05";
      inputs.nixpkgs.follows = "nixpkgs";
    };
    unstable.url = "github:nixos/nixpkgs/nixos-unstable";

    disko = {
      url = "github:nix-community/disko";
      inputs.nixpkgs.follows = "nixpkgs";
    };

    home-manager = {
      url = "github:nix-community/home-manager/release-26.05";
      inputs.nixpkgs.follows = "nixpkgs";
    };

    sops-nix = {
      url = "github:Mic92/sops-nix";
      inputs.nixpkgs.follows = "nixpkgs";
    };

    hosts = {
      url = "github:StevenBlack/hosts";
      inputs.nixpkgs.follows = "nixpkgs";
    };

    keys = {
      url = "https://github.com/jonpulsifer.keys";
      flake = false;
    };
    rowbuttkeys = {
      url = "https://github.com/rowbutt.keys";
      flake = false;
    };
    wannabekeys = {
      url = "https://github.com/wannabehero.keys";
      flake = false;
    };
  };

  # Add a host: one file in nix/hosts/ and one entry in nix/hosts/default.nix.
  # Nothing below needs touching — every output is derived from that registry.
  outputs =
    inputs@{ nixpkgs, ... }:
    let
      inherit (nixpkgs) lib;

      forAllSystems = lib.genAttrs [
        "x86_64-linux"
        "aarch64-linux"
      ];

      pkgsFor = forAllSystems (
        system:
        import nixpkgs {
          inherit system;
          config.allowUnfree = true;
          overlays = [ (import ./nix/overlays/mise.nix) ];
        }
      );

      fleet = import ./nix/lib/registry.nix {
        inherit lib;
        registry = import ./nix/hosts;
        inherit
          (import ./nix/lib/mkHost.nix {
            inherit lib inputs;
            inherit (lib) nixosSystem;
          })
          mkHost
          ;
      };
    in
    {
      inherit (fleet) nixosConfigurations;

      packages = forAllSystems fleet.packagesFor;

      checks.x86_64-linux = import ./nix/lib/checks.nix {
        inherit lib;
        inherit (fleet) nixosConfigurations;
        pkgs = pkgsFor.x86_64-linux;
      };

      apps = forAllSystems (
        system:
        (import ./nix/lib/apps.nix).mkApps {
          pkgs = pkgsFor.${system};
          inherit (fleet) deployHosts;
        }
      );

      devShells = forAllSystems (system: {
        default = import ./shell.nix { pkgs = pkgsFor.${system}; };
      });

      formatter = forAllSystems (system: pkgsFor.${system}.nixfmt-tree);

      legacyPackages = pkgsFor;
    };
}
