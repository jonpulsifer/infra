# fleet-controller (apps/fleet-controller) on spore: it reads the site's kubernetes-node devices
# from NetBox on capsule and owns the Hardware, Machine and Workflow objects in Tinkerbell's
# namespace (./tinkerbell.nix). A device's desired_action starts a provision Workflow; a device in
# decommissioning is wiped and set offline. It reconciles every two minutes and when NetBox's
# event-rule webhook posts to port 8446 on the Anchor network.
#
# It also renders the config a worker's first boot from disk fetches: talos-attest posts /render
# on the same port at the end of a full intake, and the controller writes
# talos/<uuid>/<code>.yaml under its state directory. nginx serves it at /talos/config on the
# enrollment name's HTTPS server here, and on a plain-HTTP port of this anchor's Anchor address
# that the other anchors' enrollment servers pass the location to (../lib/talos-config.nix,
# ./talos-enroll.nix). The controller follows nginx's log of the location, burns a served file and
# sets the device active.
{
  config,
  lib,
  pkgs,
  ...
}:
let
  lab = import ../lib/anchor.nix;
  fleet = import ../lib/fleet.nix;
  talosConfig = import ../lib/talos-config.nix;
  cfg = config.homelab.fleetController;
  sopsFile = ../secrets/spore.sops.yaml;
  secrets = "\n" + (if builtins.pathExists sopsFile then builtins.readFile sopsFile else "");
  # sops leaves key names in the clear, so evaluation can see which secrets the file holds.
  sealed = key: lib.hasInfix "\nfleet-controller:\n" secrets && lib.hasInfix "\n    ${key}:" secrets;
  webhook = sealed "webhook-secret";

  netboot = lib.importJSON ../../clusters/folly/talos/netboot.json;
  spore = lab.bootstrap.hosts.spore;
  vip = lab.bootstrap.vip;
  # Tinkerbell's gRPC port, ./tinkerbell.nix's tinkServerPort.
  tinkServerPort = 42113;
  # The command line nix/images/hookos-folly.nix bakes into the UKI. Without Secure Boot,
  # systemd-stub takes iPXE's arguments instead, so the per-MAC script passes the same one.
  hookosCmdline = lib.concatStringsSep " " [
    "facility="
    "syslog_host=${spore}"
    "grpc_authority=${spore}:${toString tinkServerPort}"
    "tinkerbell_tls=false"
    "tinkerbell_insecure_tls=false"
    "modules=loop,squashfs,sd-mod,usb-storage"
    "intel_iommu=on"
    "iommu=pt"
    "console=ttyS0,115200"
    "console=tty0"
    "tink_worker_image=${netboot.tink_agent_image}"
  ];
  kubeCredentials = [
    "ca-crt"
    "admin-crt"
    "admin-key"
  ];
  fleet-controller = pkgs.callPackage ../../apps/fleet-controller/package.nix { };
  talosctl = pkgs.callPackage ../../apps/talos-enroll/talosctl.nix { };
  # The worker subset of the secrets bundle that ./talos-enroll.nix loads; the controller renders
  # workers only, and refuses a control plane.
  workerSecrets = config.sops.secrets ? "talos-enroll/worker-secrets";

  # A UUID and a code that match their shapes name a file; anything else names none, so nginx
  # never builds a path from a raw query argument.
  configMap = ''
    log_format fleet '$time_iso8601 $arg_uuid $arg_code $status';
    map "$arg_uuid/$arg_code" $fleet_talos_config {
      "~^(?<fleet_uuid>[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/(?<fleet_code>[A-Za-z0-9_-]{43})$" /talos/$fleet_uuid/$fleet_code.yaml;
      default /talos/-;
    }
  '';
  serveConfig = {
    root = talosConfig.stateDir;
    extraConfig = ''
      limit_except GET {
        deny all;
      }
      types { }
      default_type text/yaml;
      add_header Cache-Control no-store always;
      try_files $fleet_talos_config =404;
      access_log ${talosConfig.log} fleet;
    '';
  };
in
{
  options.homelab.fleetController = {
    enable = lib.mkOption {
      type = lib.types.bool;
      default = sealed "netbox-token";
      defaultText = "spore's sops file holds fleet-controller/netbox-token";
      description = "Run fleet-controller. It needs a NetBox token that may read and change dcim devices and add journal entries.";
    };
    site = lib.mkOption {
      type = lib.types.str;
      default = "folly";
      description = "The NetBox site whose kubernetes-node devices the controller manages.";
    };
    webhookPort = lib.mkOption {
      type = lib.types.port;
      default = 8446;
      description = "The port NetBox's event-rule webhook and talos-attest's render call post to, on the Anchor network.";
    };
  };

  config = lib.mkIf cfg.enable {
    assertions = [
      {
        assertion = config.sops.secrets ? "tinkerbell/admin-crt";
        message = "fleet-controller.nix reaches Tinkerbell's API with the certificates that tinkerbell.nix declares.";
      }
    ];

    sops.secrets = {
      "fleet-controller/netbox-token" = { };
      # talos-attest signs its render calls with it (./talos-attest.nix).
      "fleet-controller/attest-secret" = { };
    }
    // lib.optionalAttrs webhook {
      # The event rule's secret in NetBox; without it the controller only polls.
      "fleet-controller/webhook-secret" = { };
    };

    # NetBox on capsule posts the webhook, and every anchor's talos-attest the render call, from
    # the Anchor network; the other anchors' nginx fetches /talos/config from it too.
    networking.firewall.extraCommands = ''
      iptables -A nixos-fw -i end0 -p tcp -s ${lab.cidr} --dport ${toString cfg.webhookPort} -j nixos-fw-accept
      iptables -A nixos-fw -i end0 -p tcp -s ${lab.cidr} --dport ${toString talosConfig.port} -j nixos-fw-accept
    '';

    # nginx reads the rendered configs through the service's group.
    users.users.fleet-controller = {
      isSystemUser = true;
      group = "fleet-controller";
    };
    users.groups.fleet-controller = { };
    users.users.${config.services.nginx.user}.extraGroups = [ "fleet-controller" ];

    services.nginx = {
      enable = true;
      commonHttpConfig = configMap;
      virtualHosts."enroll.${fleet.dnsZone}".locations."= /talos/config" = serveConfig;
      virtualHosts.talos-config = {
        listen = [
          {
            addr = lab.hosts.spore;
            port = talosConfig.port;
          }
        ];
        locations."/".return = "404";
        locations."= /talos/config" = serveConfig;
      };
    };

    # nginx keeps its logs 0750 and 0640; the controller reads the talos-config log through an
    # ACL, which new files inherit from the directory's default ACL.
    systemd.tmpfiles.rules = [
      "a+ /var/log/nginx - - - - group:fleet-controller:r-x,default:group:fleet-controller:r--"
      "a+ ${talosConfig.log} - - - - group:fleet-controller:r--"
    ];

    systemd.services.fleet-controller = {
      description = "NetBox to Tinkerbell fleet controller";
      wantedBy = [ "multi-user.target" ];
      wants = [
        "network-online.target"
        "tinkerbell.service"
      ];
      after = [
        "network-online.target"
        "tinkerbell.service"
      ];
      environment = {
        FLEET_SITE = cfg.site;
        FLEET_NAMESPACE = "tinkerbell";
        FLEET_TEMPLATE = "provision";
        # NetBox runs on capsule (./netbox.nix) and serves the anchors on its Anchor network
        # address; the anchors are no tailnet peers of one another.
        FLEET_NETBOX_URL = "http://${lab.hosts.capsule}:8080";
        FLEET_NETBOX_TOKEN_FILE = "%d/netbox-token";
        FLEET_KUBE_SERVER = "https://localhost:6443";
        FLEET_KUBE_CA_FILE = "%d/ca-crt";
        FLEET_KUBE_CERT_FILE = "%d/admin-crt";
        FLEET_KUBE_KEY_FILE = "%d/admin-key";
        # nginx's path for the signed HookOS UKI (./talos-boot.nix), and talos-attest's device flow
        # over TLS on the enrollment name at the boot VIP (./talos-attest.nix); chrony answers NTP
        # at the VIP too.
        FLEET_HOOKOS_URL = "http://${spore}/talos/${cfg.site}/hookos-amd64-secureboot-uki.efi";
        FLEET_HOOKOS_CMDLINE = hookosCmdline;
        FLEET_ATTEST_URL = "https://enroll.${fleet.dnsZone}/attest";
        FLEET_NTP_SERVER = vip;
        FLEET_WEBHOOK_ADDR = ":${toString cfg.webhookPort}";
        FLEET_INTERVAL = "2m";
        FLEET_WORKFLOW_TTL = "168h";
        FLEET_ATTEST_SECRET_FILE = "%d/attest-secret";
        FLEET_STATE_DIR = talosConfig.stateDir;
        FLEET_CONFIG_LOG = talosConfig.log;
        FLEET_CONFIG_TTL = "2h";
        # talosctl writes its patch files and nothing else here.
        HOME = "/tmp";
      }
      // lib.optionalAttrs webhook { FLEET_WEBHOOK_SECRET_FILE = "%d/webhook-secret"; }
      // lib.optionalAttrs workerSecrets {
        # Written by `mise run render-class-inputs` from the Talos root.
        FLEET_CLASS_INPUTS = "${../../clusters/${cfg.site}/apps/talos-enroll/class-inputs.json}";
        FLEET_WORKER_SECRETS = "%d/worker-secrets";
        FLEET_TALOSCTL = lib.getExe talosctl;
      };
      serviceConfig = {
        ExecStart = lib.getExe fleet-controller;
        LoadCredential = [
          "netbox-token:${config.sops.secrets."fleet-controller/netbox-token".path}"
        ]
        ++ map (name: "${name}:${config.sops.secrets."tinkerbell/${name}".path}") kubeCredentials
        ++ lib.optional webhook "webhook-secret:${
          config.sops.secrets."fleet-controller/webhook-secret".path
        }"
        ++ [ "attest-secret:${config.sops.secrets."fleet-controller/attest-secret".path}" ]
        ++ lib.optional workerSecrets "worker-secrets:${
          config.sops.secrets."talos-enroll/worker-secrets".path
        }";
        User = "fleet-controller";
        Group = "fleet-controller";
        StateDirectory = "fleet-controller";
        StateDirectoryMode = "0750";
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
        ProtectProc = "invisible";
        ProtectSystem = "strict";
        RestrictAddressFamilies = [
          "AF_UNIX"
          "AF_INET"
          "AF_INET6"
        ];
        RestrictNamespaces = true;
        RestrictRealtime = true;
        RestrictSUIDSGID = true;
        SystemCallArchitectures = "native";
        SystemCallFilter = [ "@system-service" ];
        SystemCallErrorNumber = "EPERM";
      };
    };
  };
}
