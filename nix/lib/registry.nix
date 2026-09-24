# Turns the fleet registry (../hosts/default.nix) into systems, packages and deploy targets.
{
  lib,
  mkHost,
  registry,
  pkgsFor,
}:
let
  isHost = entry: (entry.kind or "host") == "host";
  isPackage = entry: (entry.kind or "host") == "package";

  defaultSystem = "x86_64-linux";
in
rec {
  # Modules that need another host's derivation live here, where every configuration is in scope.
  crossHostModules = {
    # spore signs and serves rackpi5's RAM-boot image for forge's EEPROM fallback.
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
  ) (lib.filterAttrs (_: entry: !isPackage entry) registry);

  # Hosts you can ssh to: what `nix run .` fans out over.
  deployHosts = lib.attrNames (lib.filterAttrs (_: isHost) registry);

  # Most aarch64 Pis publish under x86_64-linux: their images pin aarch64 internally and the image-builder
  # workflow asks for x86_64 names. The cross-compiled Pi Zeros must build on aarch64, so they publish there.
  packagesFor =
    system:
    lib.mapAttrs
      (
        name: entry:
        if isPackage entry then
          pkgsFor.${entry.system or defaultSystem}.callPackage entry.module { }
        else
          nixosConfigurations.${name}.config.system.build.${entry.artifact}
      )
      (
        lib.filterAttrs (
          _: entry: (entry ? artifact || isPackage entry) && (entry.packageSystem or defaultSystem) == system
        ) registry
      );
}
