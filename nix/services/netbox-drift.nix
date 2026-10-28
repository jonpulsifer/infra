# The hourly drift check of folly's nodes against NetBox (scripts/inventory.sh check --record), and
# the check that NetBox's export matches clusters/folly/inventory/machines.yaml on main. It reads
# each node over the Talos API with an os:reader certificate it mints from the OS CA in folly's
# secrets bundle for each run, and exports netbox_drift for node-exporter.
{
  config,
  lib,
  pkgs,
  ...
}:
let
  fleet = import ../lib/fleet.nix;
  secret = name: config.sops.secrets.${name}.path;
  metricsDir = "/var/lib/prometheus-node-exporter-text-files";
  exported = "https://raw.githubusercontent.com/jonpulsifer/infra/main/clusters/folly/inventory/machines.yaml";
  talosctl = pkgs.callPackage ../../apps/talos-enroll/talosctl.nix { };

  tools = pkgs.stdenvNoCC.mkDerivation {
    name = "netbox-inventory";
    src = lib.fileset.toSource {
      root = ../..;
      fileset = lib.fileset.unions [
        ../../scripts/inventory.sh
        ../../scripts/netbox-export.sh
        ../../scripts/lib/netbox.sh
      ];
    };
    nativeBuildInputs = [ pkgs.makeWrapper ];
    installPhase = ''
      mkdir -p $out/bin $out/libexec
      cp -r scripts $out/libexec/
      for tool in inventory netbox-export; do
        makeWrapper ${lib.getExe pkgs.bash} $out/bin/$tool \
          --add-flags $out/libexec/scripts/$tool.sh \
          --prefix PATH : ${
            lib.makeBinPath [
              pkgs.bash
              pkgs.coreutils
              pkgs.curl
              pkgs.diffutils
              pkgs.gawk
              pkgs.gnugrep
              pkgs.jq
              pkgs.yq-go
              talosctl
            ]
          }
      done
    '';
  };

  check = pkgs.writeShellScript "netbox-drift" ''
    set -euo pipefail
    cd "$RUNTIME_DIRECTORY"
    bundle="$CREDENTIALS_DIRECTORY/bundle"
    yq -r '.certs.os.crt' "$bundle" | base64 -d > os.crt
    yq -r '.certs.os.key' "$bundle" | base64 -d > os.key
    talosctl gen key --name reader >/dev/null
    talosctl gen csr --key reader.key --ip 127.0.0.1 --roles os:reader >/dev/null
    talosctl gen crt --ca os --csr reader.csr --name reader --hours 1 >/dev/null
    rm os.key
    jq -n --rawfile ca os.crt --rawfile crt reader.crt --rawfile key reader.key '{
      context: "folly",
      contexts: {folly: {endpoints: [], ca: ($ca | @base64), crt: ($crt | @base64), key: ($key | @base64)}}
    }' > talosconfig

    # The check exits 1 on drift; only a finished check writes the metrics.
    inventory check --record --metrics drift.prom || true
    [ -s drift.prom ]

    if curl -fsS --max-time 30 -o main.yaml ${exported}; then
      stale=0
      netbox-export --check main.yaml || stale=1
      {
        echo "# HELP netbox_export_drift Whether NetBox's export differs from machines.yaml on main."
        echo "# TYPE netbox_export_drift gauge"
        echo "netbox_export_drift $stale"
      } >> drift.prom
    fi
    {
      echo "# HELP netbox_drift_last_success_timestamp_seconds Unix time of the last finished drift check."
      echo "# TYPE netbox_drift_last_success_timestamp_seconds gauge"
      echo "netbox_drift_last_success_timestamp_seconds $(date +%s)"
    } >> drift.prom
  '';

  publish = pkgs.writeShellScript "netbox-drift-publish" ''
    ${pkgs.coreutils}/bin/install -m 0644 "$RUNTIME_DIRECTORY/drift.prom" ${metricsDir}/.netbox-drift.prom
    ${pkgs.coreutils}/bin/mv ${metricsDir}/.netbox-drift.prom ${metricsDir}/netbox-drift.prom
  '';
in
{
  sops.secrets."netbox/api-token" = { };

  systemd.services.netbox-drift = {
    description = "Compare folly's nodes with NetBox";
    wants = [ "network-online.target" ];
    after = [
      "network-online.target"
      "netbox.service"
    ];
    path = [
      tools
      talosctl
      pkgs.coreutils
      pkgs.curl
      pkgs.jq
      pkgs.yq-go
    ];
    environment = {
      NETBOX_URL = "http://127.0.0.1:8080";
      NETBOX_HOST = "${config.networking.hostName}.${fleet.tailnet}";
      NETBOX_TOKEN_FILE = "%d/api-token";
      INVENTORY_TOPOLOGY = "${../../clusters/folly/config/cluster-topology.json}";
      TALOSCONFIG = "%t/netbox-drift/talosconfig";
      HOME = "/tmp";
    };
    serviceConfig = {
      Type = "oneshot";
      DynamicUser = true;
      ExecStart = check;
      # Root only installs the finished file into node-exporter's directory.
      ExecStartPost = "+${publish}";
      LoadCredential = [
        "api-token:${secret "netbox/api-token"}"
        "bundle:${secret "talos-enroll/bundle"}"
      ];
      RuntimeDirectory = "netbox-drift";
      UMask = "0077";
      CapabilityBoundingSet = "";
      LockPersonality = true;
      MemoryDenyWriteExecute = true;
      NoNewPrivileges = true;
      PrivateDevices = true;
      ProtectClock = true;
      ProtectControlGroups = true;
      ProtectHome = true;
      ProtectHostname = true;
      ProtectKernelLogs = true;
      ProtectKernelModules = true;
      ProtectKernelTunables = true;
      ProtectSystem = "strict";
      RestrictAddressFamilies = [
        "AF_UNIX"
        "AF_INET"
        "AF_INET6"
      ];
      RestrictNamespaces = true;
      RestrictRealtime = true;
      SystemCallArchitectures = "native";
    };
  };

  systemd.timers.netbox-drift = {
    description = "Hourly drift check of folly's nodes against NetBox";
    wantedBy = [ "timers.target" ];
    timerConfig = {
      OnCalendar = "hourly";
      RandomizedDelaySec = "5m";
      Persistent = true;
    };
  };
}
