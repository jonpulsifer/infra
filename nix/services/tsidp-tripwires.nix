# Counts the requests tsidp refuses, from its journal, for node-exporter. At -log=info tsidp logs
# no request it answers: only a refusal, as `HTTP error status=<n> method=<m> path=<p> ...` at WARN
# (401, 403) or ERROR (500). A refusal of /authorize, the admin UI, /clients or /register carries
# desc="not allowed over funnel" or "not available over funnel", the one mark of a Funnel request;
# any other refusal's route is unknown. -log=debug adds only other errors and the authorize
# redirect, whose URL holds the code, so info stays. Nothing here runs until services.tsidp does.
{
  config,
  lib,
  pkgs,
  ...
}:
let
  metricsDir = "/var/lib/prometheus-node-exporter-text-files";
  stateDir = "/var/lib/tsidp-tripwires";
  paths = [
    "discovery"
    "jwks"
    "token"
    "authorize"
    "userinfo"
    "introspect"
    "register"
    "clients"
    "other"
  ];

  # Adds this run's refusals to the stored counts and prints every via and path, so each series
  # exists at 0 before its first refusal and a first increase is seen.
  count = pkgs.writeText "tsidp-tripwires.awk" ''
    BEGIN {
      while ((getline line < counts) > 0) { split(line, f, " "); n[f[1]] = f[2] }
    }
    / HTTP error / {
      path = ""
      if (match($0, / path=("[^"]*"|[^ ]*)/)) { path = substr($0, RSTART + 6, RLENGTH - 6); gsub(/"/, "", path) }
      via = $0 ~ /desc="not (allowed|available) over funnel"/ ? "funnel" : "unknown"
      if (path == "/.well-known/openid-configuration") p = "discovery"
      else if (path == "/.well-known/jwks.json") p = "jwks"
      else if (path ~ /^\/(token|authorize|userinfo|introspect|register)$/) p = substr(path, 2)
      else if (path ~ /^\/clients(\/|$)/) p = "clients"
      else p = "other"
      n[via "," p]++
    }
    END {
      split("${lib.concatStringsSep " " paths}", ps, " ")
      for (v = 1; v <= 2; v++) for (i in ps) { k = (v == 1 ? "funnel" : "unknown") "," ps[i]; print k, n[k] + 0 }
    }
  '';
in
{
  config = lib.mkIf config.services.tsidp.enable {
    systemd.services.tsidp-tripwires = {
      description = "Export the requests tsidp refused, from its journal";
      path = [
        pkgs.coreutils
        pkgs.gawk
        config.systemd.package
      ];
      serviceConfig = {
        Type = "oneshot";
        UMask = "0022";
        StateDirectory = baseNameOf stateDir;
        NoNewPrivileges = true;
        PrivateTmp = true;
        ProtectHome = true;
        ProtectSystem = "strict";
        ReadWritePaths = [ metricsDir ];
      };
      script = ''
        set -u
        touch ${stateDir}/counts
        journalctl --unit=tsidp.service --cursor-file=${stateDir}/cursor --output=cat --no-pager --quiet \
          | awk -v counts=${stateDir}/counts -f ${count} >${stateDir}/counts.new
        mv ${stateDir}/counts.new ${stateDir}/counts
        metrics=$(mktemp ${metricsDir}/.tsidp-tripwires.XXXXXX)
        trap 'rm -f "$metrics"' EXIT
        {
          printf '# HELP tsidp_refused_requests_total Requests tsidp refused, by path and by whether it marked them as over Funnel.\n'
          printf '# TYPE tsidp_refused_requests_total counter\n'
          awk '{ split($1, k, ","); printf "tsidp_refused_requests_total{via=\"%s\",path=\"%s\"} %s\n", k[1], k[2], $2 }' ${stateDir}/counts
        } >"$metrics"
        # node_exporter reads the textfile directory as its own user.
        chmod 0644 "$metrics"
        mv "$metrics" ${metricsDir}/tsidp-tripwires.prom
        trap - EXIT
      '';
    };

    systemd.timers.tsidp-tripwires = {
      wantedBy = [ "timers.target" ];
      timerConfig = {
        OnBootSec = "2m";
        OnUnitActiveSec = "1m";
      };
    };
  };
}
