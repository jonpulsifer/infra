{
  config,
  lib,
  pkgs,
  ...
}:

with lib;

let
  cfg = config.services.ddnsb0t;
in
{
  meta.maintainers = [ maintainers.jonpulsifer ];
  options.services.ddnsb0t = {
    enable = mkEnableOption "ddnsb0t robot";

    domain = mkOption {
      type = types.str;
      example = "home.example.com";
      description = "The default domain to use for the FQDN";
    };

    endpoint = mkOption {
      type = types.str;
      example = "https://region-project-id.cloudfunctions.net/endpoint";
      description = "The Cloud Functions endpoint to emit events to";
    };

    token = mkOption {
      type = types.str;
      example = "abcdefg";
      description = "(optional) a shared token that can be used to prevent abuse";
      default = "homelabisthedopestlab";
    };

    package = mkOption {
      type = types.package;
      default = pkgs.ddnsb0t;
      defaultText = literalExpression "pkgs.ddnsb0t";
      description = "github.com/jonpulsifer/ddnsb0t";
    };
  };

  config = mkIf cfg.enable {
    home.packages = [ cfg.package ];
    systemd.user = {
      services.ddnsb0t = {
        Install.WantedBy = [ "default.target" ];
        Unit.Description = "ddnsb0t";
        Service = {
          Environment = [
            "DDNS_DOMAIN=${cfg.domain}"
            "DDNS_ENDPOINT=${cfg.endpoint}"
            "DDNS_API_TOKEN=${cfg.token}"
          ];
          ExecStart = "${cfg.package}/bin/ddnsb0t";
          ProtectSystem = "strict";
          Restart = "on-failure";
        };
      };
    };
  };
}
