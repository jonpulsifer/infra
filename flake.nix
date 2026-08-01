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

  outputs =
    inputs@{ nixpkgs, ... }:
    let
      lib = nixpkgs.lib;
      inherit (lib) genAttrs nixosSystem;

      systems = [
        "x86_64-linux"
        "aarch64-linux"
      ];
      forAllSystems = f: genAttrs systems (system: f system);

      inherit
        (import ./nix/lib/mkHost.nix {
          inherit lib nixosSystem inputs;
        })
        mkHost
        ;

      # The one list. Everything below is derived from it — see nix/hosts/default.nix.
      registry = import ./nix/hosts;

      isHost = entry: (entry.kind or "host") == "host";
      deployHosts = lib.attrNames (lib.filterAttrs (_: isHost) registry);

      # Cross-host wiring: edges that belong to neither host alone because they
      # need a derivation from the other. Kept here, where both configurations
      # are in scope, rather than split across two host files.
      crossHostModules = {
        # Spore signs and serves rackpi5's RAM-boot image for forge's EEPROM
        # fallback path. See nix/hosts/spore.nix and nix/hosts/rackpi5.nix.
        spore = [
          {
            services.spore.nativeBootTargets.rackpi5 = {
              package = nixosConfigurations.rackpi5.config.system.build.piBootImg;
              signingKey = "/var/lib/pi-boot-sign/private.pem";
              httpPath = "/rackpi5-ram/";
            };
          }
        ];
      };

      nixosConfigurations = lib.mapAttrs (
        name: entry:
        mkHost name {
          system = entry.system or "x86_64-linux";
          tags = entry.tags or [ ];
          baseline = entry.baseline or (if isHost entry then "fleet" else "base");
          modules = [
            (entry.module or (./nix/hosts + "/${name}.nix"))
          ]
          ++ (crossHostModules.${name} or [ ]);
        }
      ) registry;

      legacyPackages = forAllSystems (
        system:
        import nixpkgs {
          inherit system;
          config.allowUnfree = true;
          overlays = [
            (import ./nix/overlays/mise.nix)
          ];
        }
      );

      # An entry's artifact is published under `packageSystem`, which for the
      # aarch64 Pis is deliberately x86_64-linux: those sdImage derivations are
      # pinned to aarch64 internally (each Pi's nixosSystem is called with
      # system = "aarch64-linux"), and the x86_64 aliases are the image-builder
      # workflow's interface. radiopi0/blinkypi0 are the exception — they are
      # cross-compiled, so their build platform genuinely has to be the machine
      # running `nix build`.
      packagesFor =
        system:
        lib.mapAttrs (name: entry: nixosConfigurations.${name}.config.system.build.${entry.artifact}) (
          lib.filterAttrs (
            _: entry: entry ? artifact && (entry.packageSystem or "x86_64-linux") == system
          ) registry
        );

      # Eval-time assertions over the whole fleet: this is where a cross-host
      # coupling gets stated instead of left to convention. They run inside
      # `nix flake check` in seconds and need no builder and no hardware.
      fleetChecks =
        pkgs:
        let
          ok = name: pkgs.runCommand "check-${name}" { } "touch $out";
          require =
            name: cond: message:
            if cond then ok name else throw "check '${name}' failed: ${message}";

          configs = lib.mapAttrs (_: c: c.config) nixosConfigurations;
          k8sHosts = lib.filterAttrs (_: c: c.services.k8s.enable or false) configs;
        in
        {
          # Every configuration still evaluates. Naming it as a check makes it
          # something you can run on its own, not just a side effect of
          # `nix flake check` walking nixosConfigurations.
          fleet-hosts-evaluate = pkgs.runCommand "check-fleet-hosts-evaluate" {
            drvPaths = lib.concatStringsSep "\n" (
              lib.mapAttrsToList (_: c: c.config.system.build.toplevel.drvPath) nixosConfigurations
            );
          } "touch $out";

          # The repo-managed cluster CA consumes Terraform PKI outputs by path.
          # Nix path interpolation is lazy, so a missing cert for a cluster that
          # has not turned clusterCa on yet fails nothing until the day it does.
          k8s-cluster-ca-certs =
            let
              missing = lib.unique (
                lib.concatMap (
                  c:
                  let
                    net = c.services.k8s.network;
                  in
                  lib.filter (f: !builtins.pathExists (./terraform/pki/certs + "/${f}")) [
                    "${net}-ca.pem"
                    "${net}-ca-bundle.pem"
                    "${net}-sa-signer.pem"
                  ]
                ) (lib.attrValues (lib.filterAttrs (_: c: c.services.k8s.clusterCa.enable) k8sHosts))
              );
            in
            require "k8s-cluster-ca-certs" (missing == [ ])
              "services.k8s.clusterCa is enabled for a cluster whose Terraform PKI outputs are missing from terraform/pki/certs: ${lib.concatStringsSep ", " missing}";

          # A control-plane node signs service-account tokens with a key that
          # only sops delivers; without the secret the apiserver unit has
          # nothing to read.
          k8s-control-plane-sa-signing-key =
            let
              missing = lib.attrNames (
                lib.filterAttrs (_: c: !((c.sops.secrets or { }) ? "k8s-sa-signing-key")) (
                  lib.filterAttrs (_: c: c.services.k8s.role == "control-plane") k8sHosts
                )
              );
            in
            require "k8s-control-plane-sa-signing-key" (missing == [ ])
              "control-plane nodes without sops.secrets.\"k8s-sa-signing-key\": ${lib.concatStringsSep ", " missing}";

          # Two normal users sharing a uid silently breaks file ownership on
          # the NFS exports every cluster host mounts.
          fleet-unique-uids =
            let
              clashing = lib.attrNames (
                lib.filterAttrs (
                  _: c:
                  let
                    uids = lib.mapAttrsToList (_: u: u.uid) (
                      lib.filterAttrs (_: u: u.isNormalUser && u.uid != null) c.users.users
                    );
                  in
                  lib.length (lib.unique uids) != lib.length uids
                ) configs
              );
            in
            require "fleet-unique-uids" (
              clashing == [ ]
            ) "hosts with two normal users sharing a uid: ${lib.concatStringsSep ", " clashing}";
        };
    in
    {
      inherit nixosConfigurations;

      packages = {
        x86_64-linux = packagesFor "x86_64-linux" // {
          netboot = legacyPackages.x86_64-linux.symlinkJoin {
            name = "netboot";
            paths = with nixosConfigurations.netboot.config.system.build; [
              netbootRamdisk
              kernel
              netbootIpxeScript
            ];
            preferLocalBuild = true;
          };
        };
        aarch64-linux = packagesFor "aarch64-linux";
      };

      # Scoped to x86_64-linux: the assertions are platform-independent, and
      # every machine that runs `nix flake check` (CI and dev shells alike) is
      # x86_64. Running them on aarch64 too would only demand a second builder.
      checks.x86_64-linux = fleetChecks legacyPackages.x86_64-linux;

      inherit legacyPackages;

      formatter = forAllSystems (system: legacyPackages.${system}.nixfmt-tree);

      devShells = forAllSystems (system: {
        default = import ./shell.nix {
          pkgs = legacyPackages.${system};
        };
      });

      apps = forAllSystems (
        system:
        (import ./nix/lib/apps.nix).mkApps {
          pkgs = legacyPackages.${system};
          inherit deployHosts;
        }
      );
    };
}
