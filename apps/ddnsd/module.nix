{ config, lib, pkgs, ... }:
with lib;
let
  cfg = config.services.ddnsd;
in
{
  options.services.ddnsd = {
    enable = mkEnableOption "ddnsd service";

    package = mkOption {
      type = types.package;
      default = pkgs.ddnsd;
      defaultText = "pkgs.ddnsd";
      description = ''
        Package that will be used for the ddnsd service.
      '';
    };

    user = mkOption {
      type = types.str;
      default = "ddnsd";
      description = ''
        User name under which ddnsd shall be run.
      '';
    };

    group = mkOption {
      type = types.str;
      default = "ddnsd";
      description = ''
        Group under which ddnsd shall be run.
      '';
    };

    interval = mkOption {
      type = types.str;
      default = "5m";
      description = ''
        The interval at which to update the DNS record. This is a string that can be parsed
        by the `parseDuration` function in Go. See https://golang.org/pkg/time/#ParseDuration
        for more information.
      '';
      example = ''
        5m
        1h
        1h30m
      '';
    };

    zone = mkOption {
      type = types.str;
      description = ''
        The zone (domain name) to update.
      '';
      example = "example.com";
    };

    name = mkOption {
      type = types.str;
      default = config.networking.hostName;
      description = ''
        The name of the record to update. If blank, the current hostname will be used. This is the default.
        `@` is used for the apex domain.
      '';
      example = ''
        @
        home
        server1
      '';
    };

    tokenFile = mkOption {
      type = types.nullOr types.str;
      default = null;
      description = ''
        The file containing the Cloudflare API token.
      '';
      example = "/var/secrets/cloudflare-api-token";
    };

    proxied = mkOption {
      type = types.bool;
      default = false;
      description = ''
        Whether to proxy the DNS record through Cloudflare's network.
      '';
    };
  };

  config = mkIf cfg.enable {
    users.groups.${cfg.group} = { };
    users.users.${cfg.user} = {
      isSystemUser = true;
      group = cfg.group;
    };

    systemd.services.ddnsd = {
      description = "Cloudflare Dynamic DNS updater - ddnsd";
      after = [ "network-online.target" ];
      requires = [ "network-online.target" ];
      wantedBy = [ "multi-user.target" ];
      serviceConfig = {
        User = cfg.user;
        Group = cfg.group;
        ExecStart = ''
          ${pkgs.ddnsd}/bin/ddnsd ${optionalString (cfg.tokenFile != null) "-token-file=" + cfg.tokenFile} \
          -interval="${cfg.interval}" \
          -name="${cfg.name}" \
          -zone="${cfg.zone}" \
          -proxied="${boolToString cfg.proxied}"
        '';
        Restart = "always";
        RestartSec = 15;
      };
    };
  };
}
