{
  config,
  lib,
  pkgs,
  ...
}:

with lib;

let
  cfg = config.services.node_exporter;
in
{
  meta.maintainers = [ maintainers.jonpulsifer ];
  options.services.node_exporter = {
    enable = mkEnableOption "Prometheus node_exporter";

    package = mkOption {
      type = types.package;
      default = pkgs.prometheus-node-exporter;
      defaultText = literalExpression "pkgs.prometheus-node-exporter thingy";
      description = "github.com/prometheus/node_exporter";
    };
  };

  config = mkIf cfg.enable {
    home.packages = [ cfg.package ];
    systemd.user = {
      services.node_exporter = {
        Install.WantedBy = [ "default.target" ];
        Unit.Description = "node_exporter";
        Service = {
          Environment = [ ];
          ExecStart = "${cfg.package}/bin/node_exporter";
          ProtectSystem = "strict";
          Restart = "on-failure";
        };
      };
    };
  };
}
