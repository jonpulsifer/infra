# fleet-controller (apps/fleet-controller) on spore: it reads the site's kubernetes-node devices
# from NetBox on capsule and owns the Hardware, Machine and Workflow objects in Tinkerbell's
# namespace (./tinkerbell.nix). A device's desired_action starts a provision Workflow; a device in
# decommissioning is wiped and set offline. It reconciles every two minutes and when NetBox's
# event-rule webhook posts to port 8446 on the Anchor network.
{
  config,
  lib,
  pkgs,
  ...
}:
let
  lab = import ../lib/anchor.nix;
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
      description = "The port NetBox's event-rule webhook posts to, on the Anchor network.";
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
    }
    // lib.optionalAttrs webhook {
      # The event rule's secret in NetBox; without it the controller only polls.
      "fleet-controller/webhook-secret" = { };
    };

    # NetBox on capsule posts the webhook from its Anchor-network address.
    networking.firewall.extraCommands = ''
      iptables -A nixos-fw -i end0 -p tcp -s ${lab.cidr} --dport ${toString cfg.webhookPort} -j nixos-fw-accept
    '';

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
        # nginx's path for the signed HookOS UKI (./talos-boot.nix) and talos-attest's device flow
        # behind the boot VIP (./talos-attest.nix); chrony answers NTP at the VIP too.
        FLEET_HOOKOS_URL = "http://${spore}/talos/${cfg.site}/hookos-amd64-secureboot-uki.efi";
        FLEET_HOOKOS_CMDLINE = hookosCmdline;
        FLEET_ATTEST_URL = "http://${vip}/attest";
        FLEET_NTP_SERVER = vip;
        FLEET_WEBHOOK_ADDR = ":${toString cfg.webhookPort}";
        FLEET_INTERVAL = "2m";
        FLEET_WORKFLOW_TTL = "168h";
      }
      // lib.optionalAttrs webhook { FLEET_WEBHOOK_SECRET_FILE = "%d/webhook-secret"; };
      serviceConfig = {
        ExecStart = lib.getExe fleet-controller;
        LoadCredential = [
          "netbox-token:${config.sops.secrets."fleet-controller/netbox-token".path}"
        ]
        ++ map (name: "${name}:${config.sops.secrets."tinkerbell/${name}".path}") kubeCredentials
        ++ lib.optional webhook "webhook-secret:${
          config.sops.secrets."fleet-controller/webhook-secret".path
        }";
        DynamicUser = true;
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
