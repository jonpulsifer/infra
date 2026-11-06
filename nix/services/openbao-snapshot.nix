# A Raft snapshot of OpenBao each night into the site's Garage bucket `openbao`, which backup-push
# copies to GCS. The snapshot is the whole PKI and every secret; with the escrowed unseal key it
# restores onto a new forge, as docs/runbooks/restore-openbao.md describes.
{
  config,
  lib,
  pkgs,
  ...
}:
let
  cfg = config.homelab.openbao;
  snap = cfg.snapshot;
  backups = import ../lib/backups.nix { inherit pkgs; };
  # The anchor's Garage site: the store this host is part of.
  site = lib.attrByPath [ "homelab" "garage" "site" ] "folly" config;
  secret = name: config.sops.secrets.${name}.path;
  service = "openbao-snapshot";
  # The AppRole secret ID, an environment line the unit reads.
  approleSecret = "openbao/snapshot-approle";
  script = pkgs.writeShellScript "openbao-snapshot" ''
    set -euo pipefail
    RCLONE_CONFIG_GARAGE_ACCESS_KEY_ID=$(<"$CREDENTIALS_DIRECTORY/garage-key-id")
    RCLONE_CONFIG_GARAGE_SECRET_ACCESS_KEY=$(<"$CREDENTIALS_DIRECTORY/garage-key-secret")
    export RCLONE_CONFIG_GARAGE_ACCESS_KEY_ID RCLONE_CONFIG_GARAGE_SECRET_ACCESS_KEY
    BAO_TOKEN=$(bao write -field=token auth/approle/login role_id=snapshot secret_id="$VAULT_APPROLE_SECRET_ID")
    export BAO_TOKEN
    file="$RUNTIME_DIRECTORY/openbao.snap"
    bao operator raft snapshot save "$file"
    rclone rcat "garage:${snap.bucket}/$(date -u +%Y-%m-%dT%H%M%SZ).snap" <"$file"
    rm -f "$file"
    rclone delete --min-age ${toString snap.keepDays}d "garage:${snap.bucket}"
    echo "snapshot stored; $(rclone lsf "garage:${snap.bucket}" | wc -l) kept"
  '';
in
{
  options.homelab.openbao.snapshot = {
    enable = lib.mkEnableOption ''
      a nightly Raft snapshot into the site's Garage bucket. It needs the AppRole secret ID
      `${approleSecret}` (`mise run openbao:approle-secret snapshot <host>`) and the Garage key
      `garage/keys/openbao` (`mise run garage:bucket openbao <host>`) in the host's sops file
    '';
    bucket = lib.mkOption {
      type = lib.types.str;
      default = "openbao";
      description = "The Garage bucket, and the name of its key.";
    };
    keepDays = lib.mkOption {
      type = lib.types.ints.positive;
      default = 14;
      description = "Snapshots older than this are deleted from the bucket. GCS keeps what backup-push copied.";
    };
  };

  config = lib.mkIf (cfg.enable && snap.enable) {
    sops.secrets = {
      ${approleSecret} = { };
      "garage/keys/${snap.bucket}/id" = { };
      "garage/keys/${snap.bucket}/secret" = { };
    };

    systemd.services.${service} = {
      description = "Snapshot OpenBao's Raft store into Garage";
      requires = [ "openbao.service" ];
      after = [
        "openbao.service"
        "network-online.target"
      ];
      wants = [ "network-online.target" ];
      path = [
        config.services.openbao.package
        pkgs.coreutils
        pkgs.rclone
      ];
      environment = {
        BAO_ADDR = config.environment.variables.BAO_ADDR;
        RCLONE_CONFIG_GARAGE_TYPE = "s3";
        RCLONE_CONFIG_GARAGE_PROVIDER = "Other";
        RCLONE_CONFIG_GARAGE_ENDPOINT = backups.s3Endpoint site;
        RCLONE_CONFIG_GARAGE_REGION = "garage";
      };
      serviceConfig = {
        Type = "oneshot";
        DynamicUser = true;
        RuntimeDirectory = service;
        RuntimeDirectoryMode = "0700";
        EnvironmentFile = secret approleSecret;
        LoadCredential = [
          "garage-key-id:${secret "garage/keys/${snap.bucket}/id"}"
          "garage-key-secret:${secret "garage/keys/${snap.bucket}/secret"}"
        ];
        ExecStart = script;
        ExecStartPost = "+${backups.heartbeat "openbao"}";
      };
    };

    systemd.timers.${service} = {
      wantedBy = [ "timers.target" ];
      timerConfig = {
        OnCalendar = "*-*-* 03:30:00";
        RandomizedDelaySec = "10m";
        Persistent = true;
      };
    };
  };
}
