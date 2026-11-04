# Counts the requests tsidp refuses, from its journal, for node-exporter. At -log=info tsidp logs
# no request it answers: only a refusal, as `HTTP error status=<n> method=<m> path=<p> code=<c>
# desc=<d>` at WARN (401, 403) or ERROR (500). A 400, such as the invalid_grant a stale refresh token
# gets after a restart, logs only at debug. A refusal of /authorize, the admin UI, /clients or
# /register carries desc="not allowed over funnel" or "not available over funnel", the one mark of
# a Funnel request; any other refusal's route is unknown. -log=debug would add the authorize
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
  errors = [
    "invalid_grant"
    "invalid_client"
    "other"
  ];

  # Adds this run's refusals to the stored counts and prints every via, path and error, so each
  # series exists at 0 before its first refusal and a first increase is seen.
  count = pkgs.writeText "tsidp-tripwires.awk" ''
    function field(name,    v) {
      if (!match($0, " " name "=(\"[^\"]*\"|[^ ]*)")) return ""
      v = substr($0, RSTART + length(name) + 2, RLENGTH - length(name) - 2)
      gsub(/"/, "", v)
      return v
    }
    BEGIN {
      while ((getline line < counts) > 0) { split(line, f, " "); n[f[1]] = f[2] }
    }
    / HTTP error / {
      path = field("path")
      code = field("code")
      via = $0 ~ /desc="not (allowed|available) over funnel"/ ? "funnel" : "unknown"
      if (path == "/.well-known/openid-configuration") p = "discovery"
      else if (path == "/.well-known/jwks.json") p = "jwks"
      else if (path ~ /^\/(token|authorize|userinfo|introspect|register)$/) p = substr(path, 2)
      else if (path ~ /^\/clients(\/|$)/) p = "clients"
      else p = "other"
      e = code == "invalid_grant" || code == "invalid_client" ? code : "other"
      n[via "," p "," e]++
    }
    END {
      split("${lib.concatStringsSep " " paths}", ps, " ")
      split("${lib.concatStringsSep " " errors}", es, " ")
      split("funnel unknown", vs, " ")
      for (v in vs) for (i in ps) for (j in es) { k = vs[v] "," ps[i] "," es[j]; print k, n[k] + 0 }
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
        pkgs.jq
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
        set -euo pipefail
        cd ${stateDir}
        touch counts
        tail_cursor() {
          journalctl --unit=tsidp.service --lines=1 --output=json --no-pager | jq -r '.__CURSOR // empty' >cursor.new
          mv cursor.new cursor
        }
        # A cursor whose entry is gone, after a vacuum, a restore or a new journal, seeks to the head
        # of the journal. Only entries later than the cursor's own time (t=, hex microseconds) count,
        # so nothing is counted twice. The first run, and a cursor journalctl cannot parse, move the
        # cursor to the tail and count nothing; a journal that cannot be read fails the run, and the
        # success stamp goes stale.
        : >messages
        if [ ! -s cursor ]; then
          tail_cursor
        elif ! journalctl --unit=tsidp.service --after-cursor="$(cat cursor)" --output=json --no-pager >entries; then
          echo "tsidp-tripwires: journalctl cannot seek to the cursor; moving it to the tail without counting" >&2
          tail_cursor
        else
          if [ -s entries ]; then
            stored=$((16#$(sed -n 's/.*;t=\([0-9a-f]*\);.*/\1/p' cursor)))
            first=$(head -n 1 entries | jq -r '.__REALTIME_TIMESTAMP')
            if [ "$first" -le "$stored" ]; then
              echo "tsidp-tripwires: the cursor no longer seeks; counting only entries after its time" >&2
            fi
            jq -r --argjson after "$stored" \
              'select((.__REALTIME_TIMESTAMP | tonumber) > $after) | .MESSAGE | strings' entries >messages
            tail -n 1 entries | jq -r '.__CURSOR' >cursor
          fi
        fi
        awk -v counts=counts -f ${count} messages >counts.new
        mv counts.new counts
        metrics=$(mktemp ${metricsDir}/.tsidp-tripwires.XXXXXX)
        trap 'rm -f "$metrics"' EXIT
        {
          printf '# HELP tsidp_refused_requests_total Requests tsidp refused, by path, error code and whether it marked them as over Funnel.\n'
          printf '# TYPE tsidp_refused_requests_total counter\n'
          awk '{ split($1, k, ","); printf "tsidp_refused_requests_total{via=\"%s\",path=\"%s\",error=\"%s\"} %s\n", k[1], k[2], k[3], $2 }' counts
          printf '# HELP tsidp_tripwires_last_success_timestamp_seconds When tsidp-tripwires last read the journal and wrote these counts.\n'
          printf '# TYPE tsidp_tripwires_last_success_timestamp_seconds gauge\n'
          printf 'tsidp_tripwires_last_success_timestamp_seconds %s\n' "$(date +%s)"
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
