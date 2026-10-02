# A daily etcd snapshot from a control-plane node into its site's Garage store.
{
  config,
  lib,
  pkgs,
  ...
}:
let
  k8s = config.services.k8s;
  backups = import ../lib/backups.nix { inherit pkgs; };
  etcdClient = config.services.kubernetes.apiserver.etcd;
  snapshot = "/var/lib/etcd-backup/etcd.db";
in
{
  assertions = [
    {
      assertion = k8s.enable && k8s.role == "control-plane";
      message = "etcd-backup.nix snapshots the local etcd, so only a control-plane node may import it";
    }
  ];

  sops.secrets."garage/etcd/id".mode = "0400";
  sops.secrets."garage/etcd/secret".mode = "0400";

  systemd.services.etcd-backup = {
    description = "Snapshot etcd into the ${k8s.network} Garage store";
    after = [
      "etcd.service"
      "network-online.target"
    ];
    wants = [ "network-online.target" ];
    environment = {
      ETCDCTL_ENDPOINTS = lib.concatStringsSep "," etcdClient.servers;
      ETCDCTL_CACERT = etcdClient.caFile;
      ETCDCTL_CERT = etcdClient.certFile;
      ETCDCTL_KEY = etcdClient.keyFile;
      RCLONE_CONFIG_GARAGE_TYPE = "s3";
      RCLONE_CONFIG_GARAGE_PROVIDER = "Other";
      RCLONE_CONFIG_GARAGE_ENDPOINT = backups.s3Endpoint k8s.network;
      RCLONE_CONFIG_GARAGE_REGION = "garage";
      RCLONE_CONFIG_GARAGE_FORCE_PATH_STYLE = "true";
      RCLONE_CONFIG_GARAGE_NO_CHECK_BUCKET = "true";
    };
    serviceConfig = {
      Type = "oneshot";
      StateDirectory = "etcd-backup";
      StateDirectoryMode = "0700";
      Nice = 19;
      IOSchedulingClass = "idle";
      ExecStartPost = backups.heartbeat "etcd";
    };
    script = ''
      set -euo pipefail
      trap 'rm -f ${snapshot} ${snapshot}.part' EXIT
      RCLONE_CONFIG_GARAGE_ACCESS_KEY_ID=$(<${config.sops.secrets."garage/etcd/id".path})
      RCLONE_CONFIG_GARAGE_SECRET_ACCESS_KEY=$(<${config.sops.secrets."garage/etcd/secret".path})
      export RCLONE_CONFIG_GARAGE_ACCESS_KEY_ID RCLONE_CONFIG_GARAGE_SECRET_ACCESS_KEY
      ${config.services.etcd.package}/bin/etcdctl snapshot save ${snapshot}
      ${pkgs.rclone}/bin/rclone copyto ${snapshot} \
        "garage:etcd/${config.networking.hostName}/$(date -u +%Y%m%dT%H%M%SZ).db"
      ${pkgs.rclone}/bin/rclone delete --min-age 14d "garage:etcd/${config.networking.hostName}/"
    '';
  };

  systemd.timers.etcd-backup = {
    wantedBy = [ "timers.target" ];
    timerConfig = {
      OnCalendar = "*-*-* 02:30:00 America/Halifax";
      Persistent = true;
    };
  };
}
