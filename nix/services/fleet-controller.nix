# fleet-controller (apps/fleet-controller) on spore: it reads the site's kubernetes-node devices
# from NetBox on capsule and owns the Hardware, Machine and Workflow objects in Tinkerbell's
# namespace (./tinkerbell.nix). A device's desired_action starts a provision Workflow; a device in
# decommissioning is wiped and set offline. It reconciles every two minutes and when NetBox's
# event-rule webhook posts to port 8446 on the Anchor network. HookOS's agent posts each machine's
# facts to /intake on that port, through every anchor's enrollment name server (./talos-boot.nix).
#
# It also renders the config a worker's first boot from disk fetches: talos-attest posts /render
# on the same port at the end of a full intake, and the controller writes
# talos/<uuid>/<code>.yaml under its state directory. nginx serves it at /talos/config on the
# enrollment name's HTTPS server here, and on a plain-HTTP port of this anchor's Anchor address
# that the other anchors' enrollment name servers pass the location to (../lib/talos-config.nix,
# ./talos-boot.nix). The controller follows nginx's log of the location, burns a served file and
# sets the device active.
#
# For a machine NetBox does not know, /intake makes an attest-only Workflow. The controller then
# binds the attested device to a stub, the model map's class and a free address in the node
# prefix, cables it to the switch port a read-only UniFi key reports, and provisions it.
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
  # A read-only UniFi API key, with which the controller finds an intake's switch port.
  unifi = cfg.unifi.url != null && sealed "unifi-api-key";
  # An intake's address comes from the node prefix. Only these keys are read, so a new node, which
  # changes NODE_ADDRESSES, leaves the service's environment alone.
  topology = (lib.importJSON ../../clusters/${cfg.site}/config/cluster-topology.json).data;

  spore = lab.bootstrap.hosts.spore;
  vip = lab.bootstrap.vip;
  # The command line nix/images/hookos-folly.nix bakes into the UKI. Without Secure Boot,
  # systemd-stub takes iPXE's arguments instead, so the per-MAC script passes the same one.
  hookosCmdline = (pkgs.callPackage ../images/hookos-folly.nix { }).cmdline;
  kubeCredentials = [
    "ca-crt"
    "admin-crt"
    "admin-key"
  ];
  fleet-controller = pkgs.callPackage ../../apps/fleet-controller/package.nix { };
  talosctl = pkgs.callPackage ../../apps/fleet-controller/talosctl.nix { };
  # The worker subset of folly's secrets bundle (scripts/talos-worker-secrets.sh), under the key
  # name it was first sealed with. The controller renders workers only, and refuses a control plane.
  workerSecrets =
    lib.hasInfix "\ntalos-enroll:\n" secrets && lib.hasInfix "\n    worker-secrets:" secrets;
  metricsDir = "/var/lib/prometheus-node-exporter-text-files";

  # A UUID and a code that match their shapes name a file; anything else names none, so nginx
  # never builds a path from a raw query argument.
  configMap = ''
    log_format fleet '$time_iso8601 $arg_uuid $arg_code $status $request_method $request_completion $body_bytes_sent';
    map "$arg_uuid/$arg_code" $fleet_talos_config {
      "~^(?<fleet_uuid>[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/(?<fleet_code>[A-Za-z0-9_-]{43})$" /talos/$fleet_uuid/$fleet_code.yaml;
      default /talos/-;
    }
  '';
  # The controller burns a file only on a whole GET of all its bytes, so a HEAD, a range or a
  # conditional request, which would serve less, is refused or served whole, and nothing is
  # compressed, since the bytes sent are compared with the file's size. An If-None-Match is
  # refused rather than answered 304, which serves nothing.
  serveConfig = {
    root = talosConfig.stateDir;
    extraConfig = ''
      if ($request_method != GET) {
        return 405;
      }
      if ($http_if_none_match) {
        return 400;
      }
      gzip off;
      max_ranges 0;
      etag off;
      if_modified_since off;
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
    installs = lib.mkOption {
      type = lib.types.bool;
      default = false;
      description = "Let a worker's provision Workflow install Talos from HookOS, with the config /render writes. Off, no Workflow installs and /render refuses every call.";
    };
    webhookPort = lib.mkOption {
      type = lib.types.port;
      default = talosConfig.controllerPort;
      description = "The port NetBox's event-rule webhook, talos-attest's render call and every anchor's intake proxy post to, on the Anchor network.";
    };
    autoProvision = lib.mkOption {
      type = lib.types.bool;
      default = true;
      description = "Set desired_action to provision on a bound intake that has a class and an address. Off, a bound intake waits for the owner.";
    };
    intakePort = lib.mkOption {
      type = lib.types.port;
      default = 24;
      description = "The prep station's switch port, where every machine intakes. UniFi seeing a machine there says nothing of its rack port: no expected_port check and no cable follow from it.";
    };
    unifi.url = lib.mkOption {
      type = lib.types.nullOr lib.types.str;
      default = null;
      example = "https://unifi.example";
      description = "The UniFi console the controller asks for an intake's switch port, with fleet-controller/unifi-api-key from spore's sops file. Unset or unsealed, an intake gets no switch port and a stub's expected_port refuses its binding off the intake port.";
    };
    modelMap = lib.mkOption {
      type = lib.types.attrsOf (
        lib.types.submodule {
          options = {
            class = lib.mkOption {
              type = lib.types.enum [
                "controlplane"
                "worker-g5"
                "worker-g2"
              ];
              description = "The Talos class a machine of the model gets.";
            };
            bmc = lib.mkOption {
              type = lib.types.enum [
                "none"
                "amt"
                "redfish"
              ];
              description = "The model's out-of-band management.";
            };
            disk = lib.mkOption {
              type = lib.types.strMatching "/dev/.+";
              description = "The disk Talos installs to.";
            };
          };
        }
      );
      default = {
        "HP EliteDesk 800 G5 Desktop Mini" = {
          class = "worker-g5";
          bmc = "amt";
          disk = "/dev/nvme0n1";
        };
      };
      description = "Class, BMC and install disk by SMBIOS model, for a machine that intakes. A model not here gets no class and no auto-provision.";
    };
  };

  config = lib.mkIf cfg.enable {
    assertions = [
      {
        assertion = config.sops.secrets ? "tinkerbell/admin-crt";
        message = "fleet-controller.nix reaches Tinkerbell's API with the certificates that tinkerbell.nix declares.";
      }
    ];

    warnings =
      lib.optional (cfg.unifi.url != null && !unifi)
        "homelab.fleetController.unifi.url is set, and spore's sops file holds no fleet-controller/unifi-api-key; intakes get no switch port.";

    sops.secrets = {
      "fleet-controller/netbox-token" = { };
      # talos-attest signs its render calls with it (./talos-attest.nix).
      "fleet-controller/attest-secret" = { };
    }
    // lib.optionalAttrs webhook {
      # The event rule's secret in NetBox; without it the controller only polls.
      "fleet-controller/webhook-secret" = { };
    }
    // lib.optionalAttrs unifi {
      "fleet-controller/unifi-api-key" = { };
    }
    // lib.optionalAttrs workerSecrets {
      "talos-enroll/worker-secrets" = { };
    };

    # NetBox on capsule posts the webhook, every anchor's talos-attest the render call and every
    # anchor's nginx the agent's intake (./talos-boot.nix), from the Anchor network; the other
    # anchors' nginx fetches /talos/config from it too.
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

    # nginx keeps its logs 0750 and 0640. The controller reads the talos-config log through ACLs:
    # it may pass through nginx's directory and read the log's own, whose new files inherit the
    # read from its default ACL.
    systemd.services.nginx.serviceConfig.LogsDirectory = lib.mkForce [
      "nginx"
      (lib.removePrefix "/var/log/" talosConfig.logDir)
    ];
    systemd.tmpfiles.rules = [
      "d ${talosConfig.logDir} 0750 ${config.services.nginx.user} ${config.services.nginx.group} -"
      "a+ /var/log/nginx - - - - group:fleet-controller:--x"
      "a+ ${talosConfig.logDir} - - - - group:fleet-controller:r-x,default:group:fleet-controller:r--"
      "a+ ${talosConfig.log} - - - - group:fleet-controller:r--"
    ];
    # The log carries install codes; three days of it is plenty to debug a boot.
    services.logrotate.settings.talos-config = {
      files = talosConfig.log;
      frequency = "daily";
      rotate = 3;
      su = "${config.services.nginx.user} ${config.services.nginx.group}";
      postrotate = "[ ! -f /var/run/nginx/nginx.pid ] || kill -USR1 `cat /var/run/nginx/nginx.pid`";
    };

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
        FLEET_INSTALLS = lib.boolToString cfg.installs;
        FLEET_AUTO_PROVISION = lib.boolToString cfg.autoProvision;
        FLEET_MODEL_MAP = builtins.toJSON cfg.modelMap;
        FLEET_INTAKE_PORT = toString cfg.intakePort;
        FLEET_NODE_PREFIX = topology.K8S_NODE_CIDR;
        # The gateway and the API server's address are in the prefix and never go to a new node.
        FLEET_NODE_RESERVED = "${topology.ROUTER_IP},${topology.API_SERVER_IP}";
        # talosctl writes its patch files and nothing else here.
        HOME = "/tmp";
      }
      // lib.optionalAttrs webhook { FLEET_WEBHOOK_SECRET_FILE = "%d/webhook-secret"; }
      // lib.optionalAttrs unifi {
        FLEET_UNIFI_URL = cfg.unifi.url;
        FLEET_UNIFI_API_KEY_FILE = "%d/unifi-api-key";
      }
      // lib.optionalAttrs workerSecrets {
        # Written by `mise run render-class-inputs` from the Talos root.
        FLEET_CLASS_INPUTS = "${../../clusters/${cfg.site}/fleet/class-inputs.json}";
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
        ++ lib.optional unifi "unifi-api-key:${config.sops.secrets."fleet-controller/unifi-api-key".path}"
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

    # The controller's /metrics, for node-exporter's textfile collector (./talos-boot.nix), since
    # its port admits only the Anchor network. A controller that does not answer leaves the file
    # empty, so its series go absent.
    systemd.services.fleet-controller-metrics = {
      description = "Export fleet-controller's metrics through node-exporter";
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
        metrics=$(mktemp ${metricsDir}/.fleet-controller.XXXXXX)
        trap 'rm -f "$metrics"' EXIT
        curl --fail --silent --max-time 5 http://127.0.0.1:${toString cfg.webhookPort}/metrics > "$metrics" || : > "$metrics"
        # node_exporter reads the textfile directory as its own user.
        chmod 0644 "$metrics"
        mv "$metrics" ${metricsDir}/fleet-controller.prom
        trap - EXIT
      '';
    };

    systemd.timers.fleet-controller-metrics = {
      description = "Periodically export fleet-controller's metrics";
      wantedBy = [ "timers.target" ];
      timerConfig = {
        OnBootSec = "2m";
        OnUnitActiveSec = "1m";
        Unit = "fleet-controller-metrics.service";
      };
    };
  };
}
