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
in
assert app.enable;
assert app.listenAddress == "127.0.0.1";
assert service.serviceConfig.StateDirectory == "spore";
assert service.serviceConfig.ExecStartPre == "-${app.package}/bin/spore-migrate";
assert service.serviceConfig.ExecStart == "${app.package}/bin/spore";
assert builtins.elem "${app.basePath}/api/boot/" (builtins.attrNames pxeLocations);
assert builtins.elem "${app.basePath}/api/scripts/" (builtins.attrNames pxeLocations);
assert lib.hasInfix "limit_except GET" pxeLocations."${app.basePath}/api/boot/".extraConfig;
assert lib.hasInfix "limit_except GET" pxeLocations."${app.basePath}/api/scripts/".extraConfig;
assert lib.hasInfix "deny all" management.extraConfig;
assert builtins.elem "spore.pirate-musical.ts.net" (
  config.services.nginx.virtualHosts.${app.managementHost}.serverAliases
);
assert config.services.nginx.tailscaleAuth.enable;
assert config.services.nginx.tailscaleAuth.expectedTailnet == "pirate-musical.ts.net";
assert !(builtins.elem app.port config.networking.firewall.allowedTCPPorts);
assert (service.requires or [ ]) == [ ];
assert (service.partOf or [ ]) == [ ];
assert lib.all (unit: !(builtins.elem unit (service.after or [ ]))) [
  "dnsmasq.service"
  "nginx.service"
  "nfs-server.service"
];
assert config.systemd.timers.spore-backup.timerConfig.Persistent;
assert builtins.elem "d /var/backup/spore 0750 spore spore -" config.systemd.tmpfiles.rules;
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
        and (.hosts["1c:69:7a:01:2a:ef"].hostname) == "nuc"' \
      '${service.environment.SPORE_CATALOG_FILE}' >/dev/null
    touch "$out"
  ''
