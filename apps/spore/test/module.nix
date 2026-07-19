{
  config,
  lib,
  pkgs,
}:
let
  app = config.services.spore;
  service = config.systemd.services.spore;
  pxeLocations = config.services.nginx.virtualHosts."spore-pxe".locations;
  management = config.services.nginx.virtualHosts.${app.managementHost}.locations."/";
  publisher = config.systemd.services.spore-native-boot-rackpi5;
  publisherExec = lib.removeSuffix " " publisher.serviceConfig.ExecStart;
  nativeLocation = config.services.nginx.virtualHosts."spore-pxe".locations."/_spore-native-boot/";
in
assert app.enable;
assert app.listenAddress == "127.0.0.1";
assert service.serviceConfig.StateDirectory == "spore";
assert service.serviceConfig.ExecStartPre == "-${app.package}/bin/spore-migrate";
assert service.serviceConfig.ExecStart == "${app.package}/bin/spore";
assert builtins.elem "${app.basePath}/api/boot/" (builtins.attrNames pxeLocations);
assert builtins.elem "${app.basePath}/api/scripts/" (builtins.attrNames pxeLocations);
assert builtins.elem "${app.basePath}/api/native-boot/" (builtins.attrNames pxeLocations);
assert lib.hasInfix "limit_except GET" pxeLocations."${app.basePath}/api/boot/".extraConfig;
assert lib.hasInfix "limit_except GET" pxeLocations."${app.basePath}/api/scripts/".extraConfig;
assert lib.hasInfix "deny all" management.extraConfig;
assert builtins.elem "spore.pirate-musical.ts.net" (
  config.services.nginx.virtualHosts.${app.managementHost}.serverAliases
);
assert config.services.nginx.tailscaleAuth.enable;
assert config.services.nginx.tailscaleAuth.expectedTailnet == "pirate-musical.ts.net";
assert !(builtins.elem app.port config.networking.firewall.allowedTCPPorts);
assert builtins.elem "spore-native-boot-rackpi5.service" service.requires;
assert (service.partOf or [ ]) == [ ];
assert lib.all (unit: !(builtins.elem unit (service.after or [ ]))) [
  "dnsmasq.service"
  "nginx.service"
  "nfs-server.service"
];
assert config.systemd.timers.spore-backup.timerConfig.Persistent;
assert builtins.elem "d /var/backup/spore 0750 spore spore -" config.systemd.tmpfiles.rules;
assert publisher.serviceConfig.User == "root";
assert publisher.serviceConfig.Group == "root";
assert publisher.serviceConfig.ProtectSystem == "strict";
assert publisher.serviceConfig.CapabilityBoundingSet == "";
assert builtins.elem "/var/lib/spore-native-boot" publisher.serviceConfig.ReadWritePaths;
assert builtins.elem app.nativeBootArtifacts.rackpi5.package publisher.restartTriggers;
assert lib.hasInfix "internal;" nativeLocation.extraConfig;
assert lib.hasInfix "alias /var/lib/spore-native-boot/;" nativeLocation.extraConfig;
pkgs.runCommand "spore-deployment-check"
  {
    nativeBuildInputs = [ pkgs.jq ];
  }
  ''
    ${pkgs.jq}/bin/jq -e \
      --arg origin '${app.catalog.serverOrigin}' \
      --arg profile '${app.catalog.defaultProfile}' \
      '.serverOrigin == $origin
        and .defaultProfile == $profile
        and (.hosts | length) == 7
        and (.hosts["1c:69:7a:01:2a:ef"].hostname) == "nuc"
        and (.nativeBootTargets.rackpi5.hostname) == "rackpi5"
        and (.nativeBootTargets.rackpi5.macAddress) == "2c:cf:67:dc:7e:9b"
        and (.nativeBootTargets.rackpi5.protocol) == "raspberry-pi-http"' \
      '${service.environment.SPORE_CATALOG_FILE}' >/dev/null
    grep -q 'spore.squashfs-sha256' '${publisherExec}'
    grep -q 'rpi-eeprom-digest' '${publisherExec}'
    touch "$out"
  ''
