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
  talosConfig = import ../lib/talos-config.nix;
  configServer = "http://${lab.hosts.${talosConfig.server}}:${toString talosConfig.port}";
  site = config.homelab.site;
  # The talos.config URL in the installer's UKI names this host (.github/workflows/talos-images.yml).
  host = "enroll.${fleet.dnsZone}";
  adminPort = 8443;
  runDir = "/run/talos-enroll";
  publicSocket = "${runDir}/public.sock";
  adminSocket = "${runDir}/admin.sock";
  metricsDir = "/var/lib/prometheus-node-exporter-text-files";
  talos-enroll = pkgs.callPackage ../../apps/talos-enroll/package.nix { };
  talosctl = pkgs.callPackage ../../apps/talos-enroll/talosctl.nix { };
  tailscale = lib.getExe config.services.tailscale.package;
  sopsFile = ../secrets/${name}.sops.yaml;
  secretLines =
    if builtins.pathExists sopsFile then lib.splitString "\n" (builtins.readFile sopsFile) else [ ];
  # sops leaves key names in the clear, so evaluation can see which secrets the file holds. A
  # key counts only inside its own section: the indented lines right after "<section>:".
  sealed =
    section: key:
    let
      step =
        acc: line:
        if acc.found then
          acc
        else if acc.inSection then
          if !lib.hasPrefix " " line then
            acc // { inSection = false; }
          else
            acc // { found = lib.hasPrefix "    ${key}:" line; }
        else
          acc // { inSection = line == "${section}:"; };
    in
    (lib.foldl step {
      inSection = false;
      found = false;
    } secretLines).found;
  # talos-attest's DevID listener on this anchor: the verdict that binds an attestation to the
  # request's UUID and node, required beside NetBox's state for an approval without a click.
  attestURL = "http://127.0.0.1:8444";
  # The worker subset of the secrets bundle renders every worker; the full bundle, which holds
  # every cluster CA key, renders a control plane too. scripts/talos-worker-secrets.sh seals the
  # subset and then drops the bundle, so an anchor holds no CA key.
  workerSecrets = sealed "talos-enroll" "worker-secrets";
  bundle = sealed "talos-enroll" "bundle";
  # NetBox on capsule (./netbox.nix) is the directory of machines and their lifecycle, read at
  # each device request over the Anchor network with talos-attest's token. The inventory export
  # answers while NetBox does not, with no attestation, so every such approval is a click.
  netbox = sealed "talos-attest" "netbox-token";

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
  assertions = [
    {
      assertion = workerSecrets || bundle;
      message = "talos-enroll on ${name} needs talos-enroll/worker-secrets or talos-enroll/bundle in ${toString sopsFile}";
    }
  ];

  sops.secrets = {
    # The webhook of the Alertmanager Discord receiver.
    "talos-enroll/discord-webhook" = { };
    # cert-manager's DNS-01 token (clusters/folly/networking/cert-manager/cloudflare-secret.sops.yaml).
    "acme/cloudflare-token" = { };
  }
  // lib.optionalAttrs workerSecrets {
    # The worker subset of folly's secrets bundle (scripts/talos-worker-secrets.sh).
    "talos-enroll/worker-secrets" = { };
  }
  // lib.optionalAttrs bundle {
    # folly's `talosctl gen secrets` bundle, the 1Password note talos-folly-secrets. It holds every
    # cluster CA key.
    "talos-enroll/bundle" = { };
  }
  // lib.optionalAttrs netbox {
    # The NetBox API token talos-attest.nix also loads; both services read and change devices.
    "talos-attest/netbox-token" = { };
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
      ENROLL_SITE = site;
      # Written by `mise run render-class-inputs` from the Talos root. A new node changes it not
      # at all: the node's facts come from the directory at request time.
      ENROLL_CLASS_INPUTS = "${../../clusters/${site}/apps/talos-enroll/class-inputs.json}";
      # NetBox's export, the directory while NetBox does not answer.
      ENROLL_INVENTORY = "${../../clusters/${site}/inventory/machines.yaml}";
      ENROLL_WORKER_SECRETS = if workerSecrets then "%d/worker-secrets" else "%d/bundle";
      ENROLL_DISCORD_WEBHOOK_FILE = "%d/discord-webhook";
      ENROLL_TALOSCTL = lib.getExe talosctl;
      # talosctl writes its patch files and nothing else here.
      HOME = "/tmp";
    }
    // lib.optionalAttrs bundle { ENROLL_SECRETS_BUNDLE = "%d/bundle"; }
    // lib.optionalAttrs netbox {
      ENROLL_NETBOX_URL = "http://${lab.hosts.capsule}:8080";
      ENROLL_NETBOX_TOKEN_FILE = "%d/netbox-token";
      ENROLL_ATTEST_URL = attestURL;
    };
    serviceConfig = {
      ExecStart = lib.getExe talos-enroll;
      User = "talos-enroll";
      Group = "talos-enroll";
      LoadCredential = [
        "discord-webhook:${config.sops.secrets."talos-enroll/discord-webhook".path}"
      ]
      ++ lib.optional workerSecrets "worker-secrets:${
        config.sops.secrets."talos-enroll/worker-secrets".path
      }"
      ++ lib.optional bundle "bundle:${config.sops.secrets."talos-enroll/bundle".path}"
      ++ lib.optional netbox "netbox-token:${config.sops.secrets."talos-attest/netbox-token".path}";
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
      // lib.genAttrs (map (route: "= ${route}") routes) (_: toServer "")
      // lib.optionalAttrs (name != talosConfig.server) {
        # The installed node's first config lives on one anchor, which serves this location itself
        # (./fleet-controller.nix); the others pass it to that anchor's Anchor address.
        "= /talos/config" = {
          proxyPass = "${configServer}/talos/config$is_args$args";
          # The query carries the install code, which stays out of this anchor's access log.
          extraConfig = ''
            if ($request_method != GET) {
              return 405;
            }
            access_log off;
            proxy_connect_timeout 5s;
          '';
        };
      };
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
