# Turns the fleet registry (../hosts/default.nix) into flake outputs.
#
# This is the only place that knows how a registry entry becomes a system, a
# package, or a deploy target. flake.nix just asks for the three results.
{
  lib,
  mkHost,
  registry,
}:
let
  isHost = entry: (entry.kind or "host") == "host";

  defaultSystem = "x86_64-linux";
in
rec {
  # Cross-host wiring: edges that belong to neither host alone because they
  # need a derivation from the other. Kept here, where both configurations are
  # in scope, rather than split across two host files.
  crossHostModules = {
    # Spore signs and serves rackpi5's RAM-boot image for forge's EEPROM
    # fallback path. See ../hosts/spore.nix and ../hosts/rackpi5.nix.
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
      system = entry.system or defaultSystem;
      tags = entry.tags or [ ];
      baseline = entry.baseline or (if isHost entry then "fleet" else "base");
      modules = [
        (entry.module or (../hosts + "/${name}.nix"))
      ]
      ++ (crossHostModules.${name} or [ ]);
    }
  ) registry;

  # Hosts you can ssh to: what `nix run .` fans out over.
  deployHosts = lib.attrNames (lib.filterAttrs (_: isHost) registry);

  # An entry's artifact is published under its `packageSystem`, which for most
  # of the aarch64 Pis is deliberately x86_64-linux: those sdImage derivations
  # are pinned to aarch64 internally (each Pi's nixosSystem is called with
  # system = "aarch64-linux"), and the x86_64 aliases are the image-builder
  # workflow's interface. radiopi0/blinkypi0 are the exception — they are
  # cross-compiled, so their build platform genuinely has to be the machine
  # running `nix build`.
  packagesFor =
    system:
    lib.mapAttrs (name: entry: nixosConfigurations.${name}.config.system.build.${entry.artifact}) (
      lib.filterAttrs (
        _: entry: entry ? artifact && (entry.packageSystem or defaultSystem) == system
      ) registry
    );
}
