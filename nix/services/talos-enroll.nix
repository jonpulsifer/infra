# talos-enroll (apps/talos-enroll) on every anchor, so enrolling a Talos node never depends on the
# cluster it joins. nginx terminates TLS for the enrollment name at the boot VIP on the bootstrap
# VLAN (./talos-boot.nix, ./anchor-vips.nix) and passes the device flow's three routes to the
# server's public socket. tailscale serve passes this anchor's tailnet name, port 8443, to the admin
# socket and sets Tailscale-User-Login, which the approver check trusts.
#
# Every anchor runs the server, and the boot VIP's holder gets every device request, so its memory
# holds the pending enrollments. A failover forgets them, and Talos starts a new device flow. Each
# server names its own approval page in the prompts and the console's QR code, so an approval
# reaches the server that holds the code.
{
  config,
  lib,
  pkgs,
  name,
  ...
}:
let
  lab = import ../lib/anchor.nix;
  fleet = import ../lib/fleet.nix;
  site = "folly";
  # The talos.config URL in the netboot UKI names this host (.github/scripts/talos-images-build.sh).
  host = "enroll.${fleet.dnsZone}";
  adminPort = 8443;
  runDir = "/run/talos-enroll";
  publicSocket = "${runDir}/public.sock";
  adminSocket = "${runDir}/admin.sock";
  metricsDir = "/var/lib/prometheus-node-exporter-text-files";
  talos-enroll = pkgs.callPackage ../../apps/talos-enroll/package.nix { };
  talosctl = pkgs.callPackage ../../apps/talos-enroll/talosctl.nix { };
  tailscale = lib.getExe config.services.tailscale.package;
  # The attest service's base URL for ENROLL_ATTEST_URL. Null keeps every approval on the owner's
  # click (apps/talos-enroll/README.md).
  attestURL = null;

  routes = [
    "/device/code"
    "/token"
    "/config"
  ];
  toServer = extra: {
    proxyPass = "http://unix:${publicSocket}";
    extraConfig = ''
      proxy_set_header X-Forwarded-For $remote_addr;
      ${extra}
    '';
  };

  # keepalived's track script for the boot VIP, and the probe below: nginx serves the name with a
  # certificate that Talos's bundled roots trust, and the server answers behind it.
  serves = pkgs.writeShellScript "talos-enroll-serves" ''
    ${pkgs.curl}/bin/curl --fail --silent --output /dev/null --max-time 2 \
      --cacert ${pkgs.cacert}/etc/ssl/certs/ca-bundle.crt \
      --resolve ${host}:443:127.0.0.1 https://${host}/healthz
  '';
in
{
  sops.secrets = {
    # folly's `talosctl gen secrets` bundle, the 1Password note talos-folly-secrets. It holds every
    # cluster CA key.
    "talos-enroll/bundle" = { };
    # The webhook of the Alertmanager Discord receiver.
    "talos-enroll/discord-webhook" = { };
    # cert-manager's DNS-01 token (clusters/folly/networking/cert-manager/cloudflare-secret.sops.yaml).
    "acme/cloudflare-token" = { };
  };

  users.users.talos-enroll = {
    isSystemUser = true;
    group = "talos-enroll";
  };
  users.groups.talos-enroll = { };
  # nginx reaches the public socket through the group; the admin socket admits only its owner.
  users.users.${config.services.nginx.user}.extraGroups = [ "talos-enroll" ];

  systemd.services.talos-enroll = {
    description = "Talos enrollment server";
    wantedBy = [ "multi-user.target" ];
    wants = [ "network-online.target" ];
    after = [ "network-online.target" ];
    environment = {
      ENROLL_ADDR = "unix:${publicSocket}";
      ENROLL_ADMIN_ADDR = "unix:${adminSocket}";
      ENROLL_ADMIN_URL = "https://${name}.${fleet.tailnet}:${toString adminPort}";
      # Tailnet logins that may approve and deny.
      ENROLL_APPROVERS = "jonathan@pulsifer.ca";
      # Written by `mise run render-machine-inputs` from the Talos root.
      ENROLL_MACHINE_INPUTS = "${../../clusters/folly/apps/talos-enroll/machine-inputs.json}";
      ENROLL_NODE_MACS = "${../../clusters/folly/apps/talos-enroll/node-macs.json}";
      ENROLL_SECRETS_BUNDLE = "%d/bundle";
      ENROLL_DISCORD_WEBHOOK_FILE = "%d/discord-webhook";
      ENROLL_TALOSCTL = lib.getExe talosctl;
      # talosctl writes its patch files and nothing else here.
      HOME = "/tmp";
    }
    // lib.optionalAttrs (attestURL != null) { ENROLL_ATTEST_URL = attestURL; };
    serviceConfig = {
      ExecStart = lib.getExe talos-enroll;
      User = "talos-enroll";
      Group = "talos-enroll";
      LoadCredential = [
        "bundle:${config.sops.secrets."talos-enroll/bundle".path}"
        "discord-webhook:${config.sops.secrets."talos-enroll/discord-webhook".path}"
      ];
      RuntimeDirectory = "talos-enroll";
      RuntimeDirectoryMode = "0750";
      UMask = "0077";
      Restart = "always";
      RestartSec = 5;
      CapabilityBoundingSet = "";
      LockPersonality = true;
      MemoryDenyWriteExecute = true;
      NoNewPrivileges = true;
      PrivateDevices = true;
      PrivateTmp = true;
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

  # The tailnet name's certificate comes from Tailscale; the handler stays in tailscaled's state, so
  # the stop removes it.
  systemd.services.talos-enroll-tailscale-serve = {
    description = "Serve the talos-enroll approval page on this anchor's tailnet name";
    wantedBy = [ "multi-user.target" ];
    wants = [ "tailscaled.service" ];
    after = [
      "tailscaled.service"
      "tailscaled-autoconnect.service"
      "talos-enroll.service"
    ];
    serviceConfig = {
      Type = "oneshot";
      RemainAfterExit = true;
      ExecStart = "${tailscale} serve --bg --https=${toString adminPort} unix:${adminSocket}";
      ExecStop = "${tailscale} serve --https=${toString adminPort} off";
      Restart = "on-failure";
      RestartSec = 30;
    };
  };

  # Talos trusts only its bundled roots before it has a config, so the name needs a public
  # certificate. The address is private, so the challenge is DNS-01.
  security.acme = {
    acceptTerms = true;
    certs.${host} = {
      dnsProvider = "cloudflare";
      dnsResolver = "1.1.1.1:53";
      credentialFiles.CLOUDFLARE_DNS_API_TOKEN_FILE = config.sops.secrets."acme/cloudflare-token".path;
      group = config.services.nginx.group;
    };
  };

  services.nginx = {
    enable = true;
    virtualHosts.${host} = {
      onlySSL = true;
      useACMEHost = host;
      # The VIP for the bootstrap VLAN, loopback for the probe. ./talos-boot.nix sets
      # ip_nonlocal_bind, so nginx binds the VIP on every anchor.
      listen =
        map
          (addr: {
            inherit addr;
            port = 443;
            ssl = true;
          })
          [
            lab.bootstrap.vip
            "127.0.0.1"
          ];
      locations = {
        "/".return = "404";
        "= /healthz" = toServer ''
          allow 127.0.0.1;
          deny all;
        '';
      }
      // lib.genAttrs (map (route: "= ${route}") routes) (_: toServer "");
    };
  };

  networking.firewall.interfaces.bootstrap.allowedTCPPorts = [ 443 ];

  # The boot VIP moves off an anchor that does not serve enrollment, as it does off one that does
  # not serve the boot files.
  services.keepalived.vrrpScripts.talos-enroll = {
    script = toString serves;
    interval = 5;
    fall = 2;
    rise = 2;
    weight = -120;
    user = "nobody";
  };
  services.keepalived.vrrpInstances.boot.trackScripts = [ "talos-enroll" ];

  # Whether this anchor serves enrollment, and the server's own /metrics, which the unix socket
  # keeps off the network. ./talos-boot.nix turns on node-exporter's textfile collector for this
  # directory and exports whether the anchor holds the boot VIP; Prometheus reads both through the
  # anchor's node exporter. The pending-code series are the VIP holder's; the others read zero.
  systemd.services.talos-enroll-check = {
    description = "Export whether this anchor serves Talos enrollment";
    serviceConfig = {
      Type = "oneshot";
      UMask = "0022";
      NoNewPrivileges = true;
      PrivateDevices = true;
      PrivateTmp = true;
      ProtectHome = true;
      ProtectSystem = "strict";
      ReadWritePaths = [ metricsDir ];
    };
    path = [
      pkgs.coreutils
      pkgs.curl
    ];
    script = ''
      set -u
      serving=0
      if ${serves}; then
        serving=1
      fi
      metrics=$(mktemp ${metricsDir}/.talos-enroll-check.XXXXXX)
      trap 'rm -f "$metrics"' EXIT
      {
        printf '# HELP talos_enroll_serving Whether nginx serves the enrollment name with a trusted certificate and talos-enroll answers behind it.\n'
        printf '# TYPE talos_enroll_serving gauge\n'
        printf 'talos_enroll_serving{site="${site}"} %s\n' "$serving"
        curl --fail --silent --max-time 5 --unix-socket ${publicSocket} http://localhost/metrics || true
      } > "$metrics"
      chmod 0644 "$metrics"
      mv "$metrics" ${metricsDir}/talos-enroll-check.prom
      trap - EXIT
    '';
  };

  systemd.timers.talos-enroll-check = {
    description = "Periodically export whether this anchor serves Talos enrollment";
    wantedBy = [ "timers.target" ];
    timerConfig = {
      OnBootSec = "2m";
      OnUnitActiveSec = "1m";
      Unit = "talos-enroll-check.service";
    };
  };
}
