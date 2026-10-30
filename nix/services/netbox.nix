# NetBox, folly's asset and lifecycle record, with local PostgreSQL and Redis. Tailscale serve is
# its only way in: nginx serves the static files and proxies gunicorn on loopback, and a nightly
# job copies a database dump and the media directory to the site's Garage bucket `netbox`.
{
  config,
  lib,
  pkgs,
  ...
}:
let
  cfg = config.services.netbox;
  backups = import ../lib/backups.nix { inherit pkgs; };
  fleet = import ../lib/fleet.nix;
  lab = import ../lib/anchor.nix;
  secret = name: config.sops.secrets.${name}.path;
  tailscale = "${config.services.tailscale.package}/bin/tailscale";

  host = "${config.networking.hostName}.${fleet.tailnet}";
  # The other anchors are no tailnet peers of this host, so they reach NetBox on the Anchor
  # network instead (fleetd on spore, nix/services/fleetd.nix).
  anchorAddr = lab.hosts.${config.networking.hostName};
  anchorPeers = lib.attrValues (
    lib.filterAttrs (name: _: name != config.networking.hostName) {
      inherit (lab.hosts) capsule spore forge;
    }
  );
  # Atlantis on offsite reaches the API from its node, VIP and pod ranges, which arrive over the
  # Site Magic tunnel unmasqueraded, as they reach capsule's ssh.
  offsite = (lib.importJSON ../../clusters/offsite/config/cluster-topology.json).data;
  offsiteSources = [
    offsite.K8S_NODE_CIDR
    offsite.LB_RANGE
    offsite.CILIUM_POD_CIDR
  ];
  nginxPort = 8080;
  superuser = "admin";
  retentionDays = 30;

  netboxManage = lib.findFirst (
    p: lib.getName p == "netbox-manage"
  ) (throw "services.netbox no longer installs netbox-manage") config.environment.systemPackages;

  ownedByNetbox = {
    owner = "netbox";
    group = "netbox";
    mode = "0400";
    restartUnits = [
      "netbox.service"
      "netbox-rq.service"
    ];
  };

  bootstrapSuperuser = pkgs.writeShellScript "netbox-superuser" ''
    set -euo pipefail
    present=$(${lib.getExe netboxManage} shell --verbosity 0 --command \
      'from users.models import User; print(User.objects.filter(username="${superuser}").exists())' | tail -n 1)
    if [ "$present" != True ]; then
      DJANGO_SUPERUSER_PASSWORD=$(<"$CREDENTIALS_DIRECTORY/superuser-password") \
        ${lib.getExe netboxManage} createsuperuser --no-input --username ${superuser} --email ${superuser}@${fleet.dnsZone}
    fi
  '';

  backupScript = pkgs.writeShellScript "netbox-backup" ''
    set -euo pipefail
    RCLONE_CONFIG_GARAGE_ACCESS_KEY_ID=$(<"$CREDENTIALS_DIRECTORY/garage-key-id")
    RCLONE_CONFIG_GARAGE_SECRET_ACCESS_KEY=$(<"$CREDENTIALS_DIRECTORY/garage-key-secret")
    export RCLONE_CONFIG_GARAGE_ACCESS_KEY_ID RCLONE_CONFIG_GARAGE_SECRET_ACCESS_KEY

    prefix="garage:netbox/$(date -u +%Y-%m-%dT%H%M%SZ)"
    ${config.services.postgresql.package}/bin/pg_dump --format=custom netbox | rclone rcat "$prefix/netbox.pgdump"
    tar -C ${cfg.dataDir} -czf - media | rclone rcat "$prefix/media.tar.gz"
    rclone delete --min-age ${toString retentionDays}d garage:netbox
  '';
in
{
  services.netbox = {
    enable = true;
    # Upgrades run migrations on the next start; move the pin on purpose.
    package = pkgs.netbox_4_5;
    secretKeyFile = secret "netbox/secret-key";
    apiTokenPeppersFile = secret "netbox/api-token-pepper";
    gunicornArgs = [
      "--workers"
      "3"
      "--threads"
      "2"
      "--timeout"
      "120"
      "--max-requests"
      "5000"
      "--max-requests-jitter"
      "500"
    ];
    settings = {
      ALLOWED_HOSTS = [
        host
        anchorAddr
      ];
      CSRF_TRUSTED_ORIGINS = [ "https://${host}" ];
    };
  };

  # A major version change needs a dump and restore, so the default never moves under the data.
  services.postgresql.package = pkgs.postgresql_17;

  sops.secrets = {
    "netbox/secret-key" = ownedByNetbox;
    "netbox/api-token-pepper" = ownedByNetbox;
    "netbox/superuser-password" = { };
    "garage/keys/netbox/id" = { };
    "garage/keys/netbox/secret" = { };
  };

  systemd.tmpfiles.rules = [ "d ${cfg.dataDir}/media 0750 netbox netbox -" ];

  users.users.nginx.extraGroups = [ "netbox" ];
  networking.firewall.extraCommands = lib.concatMapStrings (peer: ''
    iptables -A nixos-fw -p tcp -s ${peer} --dport ${toString nginxPort} -j nixos-fw-accept
  '') (anchorPeers ++ offsiteSources);

  services.nginx = {
    enable = true;
    virtualHosts.netbox = {
      serverName = host;
      listen = [
        {
          addr = "127.0.0.1";
          port = nginxPort;
        }
        {
          addr = anchorAddr;
          port = nginxPort;
        }
      ];
      locations."/static/".alias = "${cfg.dataDir}/static/";
      # Tailscale serve terminates TLS, so the origin the browser sees is https.
      locations."/" = {
        proxyPass = "http://${cfg.listenAddress}:${toString cfg.port}";
        extraConfig = ''
          proxy_set_header Host $host;
          proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
          proxy_set_header X-Forwarded-Proto https;
        '';
      };
    };
  };

  systemd.services = {
    netbox-serve = {
      description = "Serve NetBox on the tailnet";
      wantedBy = [ "multi-user.target" ];
      wants = [ "tailscaled.service" ];
      after = [
        "tailscaled.service"
        "nginx.service"
      ];
      # tailscale serve fails until tailscaled is logged in; keep retrying.
      startLimitIntervalSec = 0;
      serviceConfig = {
        Type = "oneshot";
        RemainAfterExit = true;
        ExecStart = "${tailscale} serve --bg --https=443 http://127.0.0.1:${toString nginxPort}";
        ExecStop = "${tailscale} serve --https=443 off";
        Restart = "on-failure";
        RestartSec = "30s";
      };
    };

    netbox-superuser = {
      description = "Create the NetBox superuser on an empty database";
      wantedBy = [ "netbox.target" ];
      requires = [ "netbox.service" ];
      after = [ "netbox.service" ];
      serviceConfig = {
        Type = "oneshot";
        RemainAfterExit = true;
        User = "netbox";
        Group = "netbox";
        ExecStart = bootstrapSuperuser;
        LoadCredential = "superuser-password:${secret "netbox/superuser-password"}";
      };
    };

    netbox-backup = {
      description = "Copy the NetBox database and media to Garage";
      requires = [ "postgresql.service" ];
      after = [ "postgresql.service" ];
      path = [
        pkgs.coreutils
        pkgs.gnutar
        pkgs.gzip
        pkgs.rclone
      ];
      environment = {
        RCLONE_CONFIG_GARAGE_TYPE = "s3";
        RCLONE_CONFIG_GARAGE_PROVIDER = "Other";
        RCLONE_CONFIG_GARAGE_ENDPOINT = backups.s3Endpoint "folly";
        RCLONE_CONFIG_GARAGE_REGION = "garage";
        RCLONE_CONFIG_GARAGE_NO_CHECK_BUCKET = "true";
      };
      serviceConfig = {
        Type = "oneshot";
        User = "netbox";
        Group = "netbox";
        ExecStart = backupScript;
        ExecStartPost = "+${backups.heartbeat "netbox"}";
        LoadCredential = [
          "garage-key-id:${secret "garage/keys/netbox/id"}"
          "garage-key-secret:${secret "garage/keys/netbox/secret"}"
        ];
        PrivateTmp = true;
        ProtectSystem = "strict";
        ProtectHome = true;
        NoNewPrivileges = true;
      };
    };
  };

  systemd.timers.netbox-backup = {
    wantedBy = [ "timers.target" ];
    timerConfig = {
      OnCalendar = "*-*-* 03:15:00";
      Persistent = true;
    };
  };
}
