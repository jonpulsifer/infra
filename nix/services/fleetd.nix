# fleetd (apps/fleetd) on spore, beside Tinkerbell (./tinkerbell.nix). It attests folly's machines
# and running nodes, issues each node's LDevID from spore's YubiKey CA (./devid-ca-yubikey.nix),
# reads the site's kubernetes-node devices from NetBox on capsule, owns the Hardware, Machine and
# Workflow objects in Tinkerbell's namespace, and renders and serves the Talos config a first boot
# fetches.
#
# Its listeners:
# - HTTPS on spore's bootstrap address, port 443, for the enrollment name, whose public certificate
#   HookOS and Talos trust before either has a config: the device flow under /attest/ and the
#   one-time config at /talos/config. The anchors' CoreDNS answers the name with this address
#   (./coredns-sinkhole.nix), and a node on the Kubernetes network reaches it through the gateway.
# - HTTP on port 8444 of the Anchor network for folly's nodes and pods: the DevID lookups, the
#   renewal and the daily check.
# - HTTP on port 8446 of the Anchor network for NetBox's event-rule webhook, and /metrics.
# - The admin API on a unix socket that `tailscale serve` publishes on the tailnet.
#
# With fleetd/folly-cordon-token sealed, it cordons a node it quarantined through the cluster's API,
# as clusters/folly/tinkerbell-access/fleet-controller-cordon.yaml's account, which may cordon nodes
# only.
{
  config,
  lib,
  pkgs,
  ...
}:
let
  lab = import ../lib/anchor.nix;
  fleet = import ../lib/fleet.nix;
  cfg = config.homelab.fleetd;
  site = cfg.site;
  sopsFile = ../secrets/spore.sops.yaml;
  secrets = "\n" + (if builtins.pathExists sopsFile then builtins.readFile sopsFile else "");
  # sops leaves key names in the clear, so evaluation can see which secrets the file holds.
  sealed = key: lib.hasInfix "\nfleetd:\n" secrets && lib.hasInfix "\n    ${key}:" secrets;
  webhook = sealed "webhook-secret";
  cordon = sealed "folly-cordon-token";
  workerSecrets = sealed "worker-secrets";
  cluster = (import ../lib/networks.nix).${site};
  # An admitted device's address comes from the node prefix. Only these keys are read, so a new
  # node, which changes the inventory export, leaves the service's environment alone.
  topology = (lib.importJSON ../../clusters/${site}/config/cluster-topology.json).data;

  bootstrapIp = lab.bootstrap.hosts.spore;
  host = "enroll.${fleet.dnsZone}";
  # The command line nix/images/hookos-folly.nix bakes into the UKI. Without Secure Boot,
  # systemd-stub takes iPXE's arguments instead, so each Hardware's script passes the same one.
  hookosCmdline = (pkgs.callPackage ../images/hookos-folly.nix { }).cmdline;
  kubeCredentials = [
    "ca-crt"
    "admin-crt"
    "admin-key"
  ];
  fleetd = pkgs.callPackage ../../apps/fleetd/package.nix { };
  talosctl = pkgs.callPackage ../../apps/fleetd/talosctl.nix { };
  yubikey = config.homelab.devidCa.yubikey;
  certs = ../../terraform/pki/certs;
  # spore's hardware DevID CA, which scripts/devid-ca-yubikey.sh commits after its apply, up to the
  # FML root.
  hardwareCert = certs + "/${site}-devid-ca-spore.pem";
  caChain = pkgs.concatText "${site}-devid-ca-spore-chain.pem" [
    hardwareCert
    (certs + "/fml-intermediate.pem")
    (certs + "/fml-root.pem")
  ];
  # Every issuing CA of the site: an LDevID capsule's or forge's CA issued before fleetd verifies
  # until the node renews it from spore's.
  bundle = certs + "/${site}-devid-ca.pem";

  tftpDir = "/var/lib/tftpboot";

  # The netboot-not-allowed directories the old tmpfiles rules made belong to root; fleetd takes
  # them over, so it can repoint and remove them. This runs as root in a directory fleetd can
  # write, so it touches only root's MAC directories and their link, and never follows a link.
  adoptTftpLinks = pkgs.writeShellScript "fleetd-adopt-tftp-links" ''
    mac='[0-9a-f]{2}(:[0-9a-f]{2}){5}'
    ${pkgs.findutils}/bin/find ${tftpDir} -mindepth 1 -maxdepth 1 -type d -user root \
      -regextype posix-extended -regex ".*/$mac" \
      -exec ${pkgs.coreutils}/bin/chown -h fleetd:fleetd {} +
    ${pkgs.findutils}/bin/find ${tftpDir} -mindepth 2 -maxdepth 2 -type l -user root \
      -regextype posix-extended -regex ".*/$mac/netboot-not-allowed" \
      -exec ${pkgs.coreutils}/bin/chown -h fleetd:fleetd {} +
  '';

  devidPort = 8444;
  adminPort = 8445;
  runDir = "/run/fleetd";
  adminSocket = "${runDir}/admin.sock";
  stateDir = "/var/lib/fleetd";
  metricsDir = "/var/lib/prometheus-node-exporter-text-files";
  tailscale = lib.getExe config.services.tailscale.package;
  # Folly's pods reach spore unmasqueraded, as they reach its SPIRE server.
  devidSources = [
    cluster.nodeCidr
    cluster.podCidr
  ];
  acmeDir = config.security.acme.certs.${host}.directory;

  # The records talos-attest kept on spore, every node's LDevID files among them, move once into
  # fleetd's state; the old directory stays as the rollback. The copy lands under a temporary name
  # and moves into place whole, so an interrupted copy runs again on the next start.
  migrate = pkgs.writeShellScript "fleetd-migrate" ''
    set -eu
    if [ -d /var/lib/talos-attest ] && [ ! -e ${stateDir}/attest ]; then
      ${pkgs.coreutils}/bin/rm -rf ${stateDir}/.attest-migrating
      ${pkgs.coreutils}/bin/cp -a /var/lib/talos-attest ${stateDir}/.attest-migrating
      ${pkgs.coreutils}/bin/chown -R fleetd:fleetd ${stateDir}/.attest-migrating
      ${pkgs.coreutils}/bin/mv -T ${stateDir}/.attest-migrating ${stateDir}/attest
    fi
  '';
in
{
  options.homelab.fleetd = {
    enable = lib.mkOption {
      type = lib.types.bool;
      default = sealed "netbox-token" && yubikey.enable && yubikey.serial != null && builtins.pathExists hardwareCert;
      defaultText = "spore's sops file holds fleetd/netbox-token, its YubiKey has a serial and terraform/pki/certs/folly-devid-ca-spore.pem exists";
      description = "Run fleetd. It needs the NetBox token and the DevID CA on spore's YubiKey.";
    };
    site = lib.mkOption {
      type = lib.types.str;
      default = config.homelab.site;
      defaultText = "config.homelab.site";
      description = "The NetBox site whose kubernetes-node devices fleetd manages.";
    };
    installs = lib.mkOption {
      type = lib.types.bool;
      default = false;
      description = "Let a worker's provision Workflow install Talos from HookOS, with the config fleetd renders. Off, no Workflow installs and nothing renders.";
    };
    controlPlanes = lib.mkOption {
      type = lib.types.bool;
      default = false;
      description = "Let a control-plane class render and install like a worker and join the cluster. fleetd then holds the full secrets bundle, fleetd/bundle in spore's sops file, with the cluster's CA keys. The control plane at the API server's address, which the Talos root bootstraps, never installs from here. Off, sops-nix does not decrypt the bundle and a control plane is refused.";
    };
    webhookPort = lib.mkOption {
      type = lib.types.port;
      default = 8446;
      description = "The port NetBox's event-rule webhook posts to, on the Anchor network.";
    };
    autoProvision = lib.mkOption {
      type = lib.types.bool;
      default = true;
      description = "Start the provision of an admitted worker that never ran a Workflow. Off, an admitted device waits for the owner.";
    };
  };

  config = lib.mkIf cfg.enable {
    assertions = [
      {
        assertion = config.sops.secrets ? "tinkerbell/admin-crt";
        message = "fleetd.nix reaches Tinkerbell's API with the certificates that tinkerbell.nix declares.";
      }
      {
        assertion = !cfg.controlPlanes || (cfg.installs && workerSecrets && sealed "bundle");
        message = "homelab.fleetd.controlPlanes needs installs, fleetd/worker-secrets and fleetd/bundle in spore's sops file.";
      }
    ];

    sops.secrets = {
      # A NetBox API token that may read and change dcim devices, interfaces, cables and IP
      # addresses, and add journal entries.
      "fleetd/netbox-token" = { };
      # cert-manager's DNS-01 token (clusters/folly/networking/cert-manager/cloudflare-secret.sops.yaml).
      "acme/cloudflare-token" = { };
    }
    // lib.optionalAttrs webhook {
      # The event rule's secret in NetBox; without it fleetd only polls.
      "fleetd/webhook-secret" = { };
    }
    // lib.optionalAttrs cordon {
      # The cordon account's token; without it a quarantine is journaled for the owner to cordon.
      "fleetd/folly-cordon-token" = { };
    }
    // lib.optionalAttrs workerSecrets {
      # The worker subset of folly's secrets bundle (scripts/talos-worker-secrets.sh).
      "fleetd/worker-secrets" = { };
    }
    // lib.optionalAttrs cfg.controlPlanes {
      # The full bundle, with the cluster's CA keys.
      "fleetd/bundle" = { };
    };

    users.users.fleetd = {
      isSystemUser = true;
      group = "fleetd";
      # The YubiKey's PIN and pcscd's card access go to this group (./devid-ca-yubikey.nix).
      extraGroups = [ "devid-ca" ];
    };
    users.groups.fleetd = { };

    # Talos trusts only its bundled roots before it has a config, so the name needs a public
    # certificate. The address is private, so the challenge is DNS-01.
    security.acme = {
      acceptTerms = true;
      certs.${host} = {
        dnsProvider = "cloudflare";
        dnsResolver = "1.1.1.1:53";
        credentialFiles.CLOUDFLARE_DNS_API_TOKEN_FILE = config.sops.secrets."acme/cloudflare-token".path;
        group = "fleetd";
      };
    };

    # The service's own metrics file lives in node-exporter's root-owned textfile directory. The
    # rule runs after the anchor profile's 0755 chmod of the directory, which would reset the ACL
    # mask.
    systemd.tmpfiles.rules = lib.mkAfter [ "a+ ${metricsDir} - - - - g:fleetd:rwx,m::rwx" ];

    systemd.services.fleetd = {
      description = "Folly's attestation, LDevID issuance, Tinkerbell installs and first-boot configs";
      wantedBy = [ "multi-user.target" ];
      # The ACME unit puts a certificate in place, self-signed until the first order, before the
      # boot listener reads it.
      wants = [
        "network-online.target"
        "tinkerbell.service"
        "acme-${host}.service"
      ];
      after = [
        "network-online.target"
        "tinkerbell.service"
        "acme-${host}.service"
      ];
      environment = {
        FLEETD_BOOT_ADDR = "${bootstrapIp}:443";
        FLEETD_TLS_CERT = "${acmeDir}/fullchain.pem";
        FLEETD_TLS_KEY = "${acmeDir}/key.pem";

        ATTEST_DEVID_ADDR = ":${toString devidPort}";
        ATTEST_ADMIN_ADDR = "unix:${adminSocket}";
        # The O of every LDevID, and the site each audit line names.
        ATTEST_SITE = site;
        ATTEST_APPROVERS = "jonathan@pulsifer.ca";
        ATTEST_CA_CHAIN = "${caChain}";
        ATTEST_CA_BUNDLE = "${bundle}";
        # The pkcs11signer contract (packages/pkcs11signer): the chain's first certificate picks the key.
        ATTEST_CA_PKCS11_MODULE = yubikey.pkcs11Module;
        ATTEST_CA_PKCS11_TOKEN = yubikey.tokenLabel;
        ATTEST_CA_PKCS11_PIN_FILE = "%d/devid-ca-pin";
        ATTEST_CA_CERT = "${caChain}";
        ATTEST_EK_ROOTS = "${../../apps/fleetd/attest/roots}";
        ATTEST_POLICY = "${../../apps/fleetd/attest/policy.yaml}";
        ATTEST_STATE_DIR = "${stateDir}/attest";
        ATTEST_METRICS_FILE = "${metricsDir}/fleetd-attest.prom";
        # NetBox runs on capsule (./netbox.nix) and serves the anchors on its Anchor network
        # address; the anchors are no tailnet peers of one another.
        ATTEST_NETBOX_URL = "http://${lab.hosts.capsule}:8080";
        ATTEST_NETBOX_TOKEN_FILE = "%d/netbox-token";

        FLEET_SITE = site;
        FLEET_NAMESPACE = "tinkerbell";
        FLEET_TEMPLATE = "provision";
        FLEET_NETBOX_URL = "http://${lab.hosts.capsule}:8080";
        FLEET_NETBOX_TOKEN_FILE = "%d/netbox-token";
        FLEET_KUBE_SERVER = "https://localhost:6443";
        FLEET_KUBE_CA_FILE = "%d/ca-crt";
        FLEET_KUBE_CERT_FILE = "%d/admin-crt";
        FLEET_KUBE_KEY_FILE = "%d/admin-key";
        # nginx's path for the signed HookOS UKI (./talos-boot.nix).
        FLEET_HOOKOS_URL = "http://${bootstrapIp}/talos/${site}/hookos-amd64-secureboot-uki.efi";
        FLEET_HOOKOS_CMDLINE = hookosCmdline;
        FLEET_WEBHOOK_ADDR = ":${toString cfg.webhookPort}";
        # Some firmware takes Smee's offer over the network's DHCP, and Smee names
        # /<mac>/netboot-not-allowed while allowPXE is off (./tinkerbell.nix). fleetd links that
        # path to the signed iPXE under dnsmasq's TFTP root for each MAC NetBox holds.
        FLEET_TFTP_DIR = tftpDir;
        FLEET_TFTP_LINK_TARGET = "${tftpDir}/talos/${site}/ipxe-amd64-secureboot.efi";
        FLEET_INTERVAL = "2m";
        FLEET_SPIRE_NODES_FILE = "${stateDir}/spire-nodes.json";
        FLEET_WORKFLOW_TTL = "168h";
        FLEET_CONFIG_TTL = "2h";
        # Rendered configs wait in this tmpfs, which RuntimeDirectoryPreserve keeps across a
        # restart, such as the one a HookOS command-line change brings, and a reboot drops.
        FLEET_CONFIG_DIR = "${runDir}/configs";
        FLEET_INSTALLS = lib.boolToString cfg.installs;
        FLEET_AUTO_PROVISION = lib.boolToString cfg.autoProvision;
        # The Talos root bootstraps etcd on the control plane at the API server's address: no
        # provision or wipe runs there, and it never installs from here.
        FLEET_BOOTSTRAP_ADDRESS = topology.API_SERVER_IP;
        # talosctl writes its patch files and nothing else here.
        HOME = "/tmp";
      }
      // lib.optionalAttrs webhook { FLEET_WEBHOOK_SECRET_FILE = "%d/webhook-secret"; }
      // lib.optionalAttrs cordon {
        FLEET_CLUSTER_SERVER = cluster.apiServer;
        FLEET_CLUSTER_CA_FILE = "${cluster.apiServerCA}";
        FLEET_CLUSTER_TOKEN_FILE = "%d/folly-cordon-token";
      }
      // lib.optionalAttrs workerSecrets {
        # Written by `mise run render-class-inputs` from the Talos root.
        FLEET_CLASS_INPUTS = "${../../clusters/${site}/fleet/class-inputs.json}";
        FLEET_WORKER_SECRETS = "%d/worker-secrets";
        FLEET_TALOSCTL = lib.getExe talosctl;
      }
      // lib.optionalAttrs cfg.controlPlanes {
        FLEET_CONTROLPLANE_BUNDLE = "%d/bundle";
        # A control plane's config carries the CA keys, so it waits unread for less time.
        FLEET_CONTROLPLANE_CONFIG_TTL = "30m";
      };
      serviceConfig = {
        ExecStartPre = [
          "+${migrate}"
          "+${adoptTftpLinks}"
        ];
        ExecStart = lib.getExe fleetd;
        LoadCredential = [
          "netbox-token:${config.sops.secrets."fleetd/netbox-token".path}"
          "devid-ca-pin:${yubikey.pinFile}"
        ]
        ++ map (name: "${name}:${config.sops.secrets."tinkerbell/${name}".path}") kubeCredentials
        ++ lib.optional webhook "webhook-secret:${config.sops.secrets."fleetd/webhook-secret".path}"
        ++ lib.optional cordon "folly-cordon-token:${config.sops.secrets."fleetd/folly-cordon-token".path}"
        ++ lib.optional workerSecrets "worker-secrets:${config.sops.secrets."fleetd/worker-secrets".path}"
        ++ lib.optional cfg.controlPlanes "bundle:${config.sops.secrets."fleetd/bundle".path}";
        User = "fleetd";
        Group = "fleetd";
        StateDirectory = "fleetd";
        StateDirectoryMode = "0750";
        RuntimeDirectory = "fleetd";
        RuntimeDirectoryMode = "0700";
        RuntimeDirectoryPreserve = "yes";
        ReadWritePaths = [
          metricsDir
          tftpDir
        ];
        UMask = "0027";
        Restart = "always";
        RestartSec = 5;
        # The boot listener's port 443.
        AmbientCapabilities = [ "CAP_NET_BIND_SERVICE" ];
        CapabilityBoundingSet = [ "CAP_NET_BIND_SERVICE" ];
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
        RestrictSUIDSGID = true;
        SystemCallArchitectures = "native";
      };
    };

    systemd.services.fleetd-tailscale-serve = {
      description = "Serve fleetd's admin API on spore's tailnet name";
      wantedBy = [ "multi-user.target" ];
      wants = [ "tailscaled.service" ];
      after = [
        "tailscaled.service"
        "tailscaled-autoconnect.service"
        "fleetd.service"
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

    # NetBox on capsule posts the webhook from the Anchor network; only folly's nodes and pods reach
    # the DevID lookups and the renewal.
    networking.firewall.extraCommands = ''
      iptables -A nixos-fw -i end0 -p tcp -s ${lab.cidr} --dport ${toString cfg.webhookPort} -j nixos-fw-accept
    ''
    + lib.concatMapStrings (cidr: ''
      iptables -A nixos-fw -i end0 -p tcp -s ${cidr} --dport ${toString devidPort} -j nixos-fw-accept
    '') devidSources;

    # fleetd's /metrics, for node-exporter's textfile collector (../profiles/anchor.nix), since its port
    # admits only the Anchor network. A fleetd that does not answer leaves the file empty, so its
    # series go absent. fleetd_devid_serving probes the DevID listener on its own, since every
    # node's renewal and daily check reach it there.
    systemd.services.fleetd-metrics = {
      description = "Export fleetd's metrics through node-exporter";
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
        metrics=$(mktemp ${metricsDir}/.fleetd.XXXXXX)
        trap 'rm -f "$metrics"' EXIT
        curl --fail --silent --max-time 5 http://127.0.0.1:${toString cfg.webhookPort}/metrics > "$metrics" || : > "$metrics"
        devid=0
        if curl --fail --silent --output /dev/null --max-time 5 http://127.0.0.1:${toString devidPort}/healthz; then
          devid=1
        fi
        {
          printf '# HELP fleetd_devid_serving Whether fleetd answers /healthz on its DevID listener.\n'
          printf '# TYPE fleetd_devid_serving gauge\n'
          printf 'fleetd_devid_serving %s\n' "$devid"
        } >> "$metrics"
        # node_exporter reads the textfile directory as its own user.
        chmod 0644 "$metrics"
        mv "$metrics" ${metricsDir}/fleetd.prom
        trap - EXIT
      '';
    };

    systemd.timers.fleetd-metrics = {
      description = "Periodically export fleetd's metrics";
      wantedBy = [ "timers.target" ];
      timerConfig = {
        OnBootSec = "2m";
        OnUnitActiveSec = "1m";
        Unit = "fleetd-metrics.service";
      };
    };
  };
}
