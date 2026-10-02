# A site's Garage S3 store, the primary target of its backups: Velero, CNPG and the etcd snapshots
# write into it over the LAN, and a cluster CronJob copies it off-site. One node, no replication.
{
  config,
  lib,
  pkgs,
  ...
}:
let
  cfg = config.homelab.garage;
  backups = import ../lib/backups.nix { inherit pkgs; };
  garage = lib.getExe config.services.garage.package;
  secret = name: config.sops.secrets.${name}.path;

  keys = [
    "velero"
    "cnpg"
    "etcd"
    "push"
  ];
  buckets = [
    "velero"
    "cnpg"
    "etcd"
  ];
  # Each key owns its own bucket; the push key only reads them all.
  grants =
    map (name: {
      bucket = name;
      key = name;
      flags = "--read --write --owner";
    }) buckets
    ++ map (bucket: {
      inherit bucket;
      key = "push";
      flags = "--read";
    }) buckets;

  # The data directory sits on a nofail mount, which tmpfiles and user creation can run before.
  dataDirUnit = "garage-data-dir.service";
in
{
  options.homelab.garage = {
    enable = lib.mkEnableOption "the site's Garage S3 backup store";
    site = lib.mkOption {
      type = lib.types.enum (lib.attrNames backups.garageHosts);
      description = "The site this host stores backups for. It names the Garage zone.";
    };
    dataDir = lib.mkOption {
      type = lib.types.str;
      description = "Garage's metadata and data root, on the host's data disk and outside any NFS export.";
    };
    capacity = lib.mkOption {
      type = lib.types.str;
      default = "100GB";
      description = "The node's layout capacity. With one node it weights nothing and enforces nothing.";
    };
  };

  config = lib.mkIf cfg.enable {
    services.garage = {
      enable = true;
      package = pkgs.garage_2;
      settings = {
        metadata_dir = "${cfg.dataDir}/meta";
        data_dir = "${cfg.dataDir}/data";
        db_engine = "sqlite";
        replication_factor = 1;
        rpc_bind_addr = "127.0.0.1:3901";
        rpc_secret_file = secret "garage/rpc-secret";
        s3_api = {
          s3_region = "garage";
          api_bind_addr = "[::]:${toString backups.s3Port}";
        };
        admin = {
          api_bind_addr = "127.0.0.1:3903";
          admin_token_file = secret "garage/admin-token";
        };
      };
    };

    users.users.garage = {
      isSystemUser = true;
      group = "garage";
    };
    users.groups.garage = { };

    networking.firewall.allowedTCPPorts = [ backups.s3Port ];

    sops.secrets = {
      "garage/rpc-secret" = {
        owner = "garage";
        group = "garage";
        mode = "0400";
        restartUnits = [ "garage.service" ];
      };
      "garage/admin-token" = {
        owner = "garage";
        group = "garage";
        mode = "0400";
        restartUnits = [ "garage.service" ];
      };
    }
    // lib.listToAttrs (
      lib.concatMap (name: [
        (lib.nameValuePair "garage/keys/${name}/id" { mode = "0400"; })
        (lib.nameValuePair "garage/keys/${name}/secret" { mode = "0400"; })
      ]) keys
    );

    systemd.services = {
      garage = {
        requires = [ dataDirUnit ];
        after = [ dataDirUnit ];
        serviceConfig = {
          DynamicUser = lib.mkForce false;
          User = "garage";
          Group = "garage";
        };
      };

      garage-data-dir = {
        description = "Create the Garage directories on the mounted data disk";
        unitConfig.RequiresMountsFor = [ cfg.dataDir ];
        before = [ "garage.service" ];
        serviceConfig = {
          Type = "oneshot";
          RemainAfterExit = true;
          ExecStart = "${pkgs.coreutils}/bin/install -d -m 0750 -o garage -g garage ${cfg.dataDir} ${cfg.dataDir}/meta ${cfg.dataDir}/data";
        };
      };

      # Applies the layout once, then imports the pre-generated keys, creates the buckets and
      # applies the grants. Every step is a no-op on a bootstrapped node. Key secrets go through
      # stdin, never argv.
      garage-bootstrap = {
        description = "Bootstrap the ${cfg.site} Garage layout, keys, buckets and grants";
        wantedBy = [ "multi-user.target" ];
        requires = [ "garage.service" ];
        after = [ "garage.service" ];
        path = [
          pkgs.coreutils
          pkgs.jq
        ];
        environment.GARAGE_CONFIG_FILE = "/etc/garage.toml";
        serviceConfig = {
          Type = "oneshot";
          RemainAfterExit = true;
        };
        script = ''
          set -euo pipefail

          for _ in $(seq 60); do
            ${garage} json-api GetClusterLayout >/dev/null 2>&1 && break
            sleep 1
          done

          layout=$(${garage} json-api GetClusterLayout)
          if [ "$(jq '.roles | length' <<<"$layout")" -eq 0 ]; then
            node=$(${garage} json-api GetClusterStatus | jq -r '.nodes[0].id')
            ${garage} layout assign -z ${cfg.site} -c ${cfg.capacity} "$node"
            ${garage} layout apply --version "$(jq '.version + 1' <<<"$layout")"
          fi

          existing=$(${garage} json-api ListKeys | jq -r '.[].id')
          import_key() {
            local name=$1 id secret
            id=$(<"$2")
            secret=$(<"$3")
            if ! grep -qxF "$id" <<<"$existing"; then
              jq -n --arg n "$name" --arg i "$id" --arg s "$secret" \
                '{name: $n, accessKeyId: $i, secretAccessKey: $s}' |
                ${garage} json-api ImportKey - >/dev/null
            fi
          }
          ${lib.concatMapStringsSep "\n" (
            name: "import_key ${name} ${secret "garage/keys/${name}/id"} ${secret "garage/keys/${name}/secret"}"
          ) keys}

          ${lib.concatMapStringsSep "\n" (
            bucket: "${garage} bucket info ${bucket} >/dev/null 2>&1 || ${garage} bucket create ${bucket}"
          ) buckets}

          ${lib.concatMapStringsSep "\n" (
            g: "${garage} bucket allow ${g.flags} ${g.bucket} --key ${g.key}"
          ) grants}
        '';
      };
    };
  };
}
