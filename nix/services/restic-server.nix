# A site's restic staging repository, served append-only by rest-server. Producers back up into it
# over the LAN, a cluster CronJob copies it to GCS, and this host prunes it directly on disk.
{
  config,
  lib,
  pkgs,
  ...
}:
let
  cfg = config.homelab.resticServer;
  backups = import ../lib/backups.nix { inherit pkgs; };
  repo = "${cfg.dataDir}/${cfg.site}";
  passwordFile = config.sops.secrets."restic/repository-password".path;
  resticEnv = {
    RESTIC_REPOSITORY = repo;
    RESTIC_PASSWORD_FILE = passwordFile;
  };
  # The data directory sits on a nofail mount, which tmpfiles and user creation can run before.
  dataDirUnit = "restic-staging-data-dir.service";
in
{
  options.homelab.resticServer = {
    enable = lib.mkEnableOption "the site's restic staging repository";
    site = lib.mkOption {
      type = lib.types.enum (lib.attrNames backups.stagingHosts);
      description = "The site whose backups this host stages. Its repository is <dataDir>/<site>.";
    };
    dataDir = lib.mkOption {
      type = lib.types.str;
      description = "rest-server's root directory, on the host's data disk.";
    };
    pruneOnCalendar = lib.mkOption {
      type = lib.types.str;
      description = "When to prune the staging repository, after the site's push to GCS.";
    };
  };

  config = lib.mkIf cfg.enable {
    services.restic.server = {
      enable = true;
      listenAddress = toString backups.port;
      inherit (cfg) dataDir;
      appendOnly = true;
      htpasswd-file = config.sops.secrets."restic/rest-server-htpasswd".path;
    };
    users.users.restic.createHome = lib.mkForce false;

    networking.firewall.allowedTCPPorts = [ backups.port ];

    sops.secrets."restic/rest-server-htpasswd" = {
      owner = "restic";
      group = "restic";
      mode = "0400";
      restartUnits = [ "restic-rest-server.service" ];
    };
    sops.secrets."restic/repository-password" = {
      owner = "restic";
      group = "restic";
      mode = "0400";
    };

    systemd.services = {
      restic-staging-data-dir = {
        description = "Create the restic staging directory on the mounted data disk";
        unitConfig.RequiresMountsFor = [ cfg.dataDir ];
        requiredBy = [ "restic-rest-server.service" ];
        before = [ "restic-rest-server.service" ];
        serviceConfig = {
          Type = "oneshot";
          RemainAfterExit = true;
          ExecStart = "${pkgs.coreutils}/bin/install -d -m 0750 -o restic -g restic ${cfg.dataDir}";
        };
      };

      # Producers could race to init the repository; the host does it once instead.
      restic-staging-init = {
        description = "Initialize the ${cfg.site} restic staging repository";
        wantedBy = [ "multi-user.target" ];
        requires = [ dataDirUnit ];
        after = [ dataDirUnit ];
        before = [ "restic-rest-server.service" ];
        environment = resticEnv;
        unitConfig.ConditionPathExists = "!${repo}/config";
        serviceConfig = {
          Type = "oneshot";
          RemainAfterExit = true;
          User = "restic";
          Group = "restic";
          ExecStart = "${pkgs.restic}/bin/restic init";
        };
      };

      restic-staging-prune = {
        description = "Prune the ${cfg.site} restic staging repository";
        requires = [ dataDirUnit ];
        after = [
          dataDirUnit
          "restic-staging-init.service"
        ];
        environment = resticEnv // {
          RESTIC_CACHE_DIR = "/var/cache/restic-staging-prune";
        };
        serviceConfig = {
          Type = "oneshot";
          User = "restic";
          Group = "restic";
          CacheDirectory = "restic-staging-prune";
          Nice = 19;
          IOSchedulingClass = "idle";
          ExecStart = lib.escapeShellArgs [
            "${pkgs.restic}/bin/restic"
            "forget"
            "--prune"
            "--keep-daily"
            "14"
            "--keep-weekly"
            "4"
            "--retry-lock"
            "30m"
          ];
          ExecStartPost = "+${backups.heartbeat "restic-staging-prune"}";
        };
      };
    };

    systemd.timers.restic-staging-prune = {
      wantedBy = [ "timers.target" ];
      timerConfig = {
        OnCalendar = cfg.pruneOnCalendar;
        Persistent = true;
      };
    };
  };
}
