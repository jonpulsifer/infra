# A daily etcd snapshot from a control-plane node into its site's restic staging repository.
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

  sops.secrets."restic/repository-password".mode = "0400";
  sops.secrets."restic/rest-server-password".mode = "0400";

  systemd.services.etcd-backup = {
    description = "Snapshot etcd into the ${k8s.network} restic staging repository";
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
      RESTIC_REPOSITORY = backups.repository k8s.network;
      RESTIC_PASSWORD_FILE = config.sops.secrets."restic/repository-password".path;
      RESTIC_REST_USERNAME = backups.restUsername;
      RESTIC_CACHE_DIR = "/var/cache/etcd-backup";
    };
    serviceConfig = {
      Type = "oneshot";
      StateDirectory = "etcd-backup";
      StateDirectoryMode = "0700";
      CacheDirectory = "etcd-backup";
      Nice = 19;
      IOSchedulingClass = "idle";
      ExecStartPost = backups.heartbeat "etcd";
    };
    script = ''
      set -euo pipefail
      trap 'rm -f ${snapshot} ${snapshot}.part' EXIT
      RESTIC_REST_PASSWORD=$(<${config.sops.secrets."restic/rest-server-password".path})
      export RESTIC_REST_PASSWORD
      ${config.services.etcd.package}/bin/etcdctl snapshot save ${snapshot}
      ${pkgs.restic}/bin/restic backup \
        --host ${k8s.network}/etcd/${config.networking.hostName} \
        --tag kind=etcd \
        --retry-lock 30m \
        ${snapshot}
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
