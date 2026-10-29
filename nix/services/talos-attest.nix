# talos-attest (apps/talos-attest) on every anchor: the device flow at the boot VIP's nginx under
# /attest/, the DevID and verdict lookups on TCP 8444 of the anchor network, and the admin API on
# the tailnet. It signs with the software DevID CA key once scripts/pki/devid-ca.sh has sealed it
# and committed its chain, or with this anchor's YubiKey over PKCS#11 (./devid-ca-yubikey.nix).
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
  folly = (import ../lib/networks.nix).folly;
  site = config.homelab.site;
  sopsFile = ../secrets/${name}.sops.yaml;
  secrets = "\n" + (if builtins.pathExists sopsFile then builtins.readFile sopsFile else "");
  # sops leaves key names in the clear, so evaluation can see which secrets the file holds.
  sealed = key: lib.hasInfix "\ntalos-attest:\n" secrets && lib.hasInfix "\n    ${key}:" secrets;
  certs = ../../terraform/pki/certs;
  softwareChain = certs + "/${site}-devid-ca-software-chain.pem";
  # This anchor's hardware DevID CA, which scripts/devid-ca-yubikey.sh commits after its apply.
  hardwareCert = certs + "/${site}-devid-ca-${name}.pem";
  yubikey = config.homelab.devidCa.yubikey;
  cfg = config.homelab.talosAttest;
  pkcs11 = cfg.caKey == "pkcs11";
  ready =
    if pkcs11 then
      yubikey.enable && yubikey.serial != null && builtins.pathExists hardwareCert
    else
      sealed "devid-ca-key" && builtins.pathExists softwareChain;
  netbox = sealed "netbox-token";

  devidPort = 8444;
  adminPort = 8445;
  runDir = "/run/talos-attest";
  publicSocket = "${runDir}/public.sock";
  adminSocket = "${runDir}/admin.sock";
  metricsDir = "/var/lib/prometheus-node-exporter-text-files";
  talos-attest = pkgs.callPackage ../../apps/talos-attest/package.nix { };
  tailscale = lib.getExe config.services.tailscale.package;
  peers = map (anchor: "http://${lab.hosts.${anchor}}:${toString devidPort}") (
    lib.remove name (lib.attrNames lab.bootstrap.hosts)
  );
  # Folly's pods reach the anchors unmasqueraded, as they reach spore's SPIRE server. The other
  # anchors ask this one for its newest verdict on the same port.
  devidSources = [
    folly.nodeCidr
    folly.podCidr
  ]
  ++ map (anchor: lab.hosts.${anchor}) (lib.remove name (lib.attrNames lab.bootstrap.hosts));

  serves = pkgs.writeShellScript "talos-attest-serves" ''
    ${pkgs.curl}/bin/curl --fail --silent --output /dev/null --max-time 2 \
      --unix-socket ${publicSocket} http://talos-attest/healthz
  '';
in
{
  options.homelab.talosAttest = {
    enable = lib.mkOption {
      type = lib.types.bool;
      default = ready;
      defaultText = "software: the anchor's sops file holds talos-attest/devid-ca-key and terraform/pki/certs/folly-devid-ca-software-chain.pem exists; pkcs11: the anchor's YubiKey has a serial and terraform/pki/certs/folly-devid-ca-<host>.pem exists";
      description = "Run talos-attest. It refuses to start without the DevID CA's key.";
    };
    caKey = lib.mkOption {
      type = lib.types.enum [
        "software"
        "pkcs11"
      ];
      default = "software";
      description = ''
        Where the DevID CA key lives: "software" is terraform/pki's key, sealed in this anchor's sops
        file; "pkcs11" is this anchor's YubiKey, homelab.devidCa.yubikey.
      '';
    };
    caChain = lib.mkOption {
      type = lib.types.path;
      default =
        if pkcs11 then
          pkgs.concatText "${site}-devid-ca-${name}-chain.pem" [
            hardwareCert
            (certs + "/fml-intermediate.pem")
            (certs + "/fml-root.pem")
          ]
        else
          softwareChain;
      defaultText = "terraform/pki/certs/folly-devid-ca-software-chain.pem, or this anchor's hardware CA up to the FML root";
      description = "The DevID CA first, then the FML intermediate and root.";
    };
  };

  config = lib.mkIf cfg.enable {
    # The service's own metrics file lives in node-exporter's root-owned textfile directory.
    systemd.tmpfiles.rules = [ "a+ ${metricsDir} - - - - g:talos-attest:rwx" ];

    assertions = [
      {
        assertion = pkcs11 -> yubikey.enable && yubikey.serial != null;
        message = "homelab.talosAttest.caKey = \"pkcs11\" needs homelab.devidCa.yubikey.enable and its serial";
      }
    ];

    sops.secrets =
      lib.optionalAttrs (!pkcs11) {
        # The DevID CA's private key, terraform/pki's devid_ca_private_key output.
        "talos-attest/devid-ca-key" = { };
      }
      // lib.optionalAttrs netbox {
        # A NetBox API token that may read and change dcim devices and add journal entries.
        "talos-attest/netbox-token" = { };
      };

    users.users.talos-attest = {
      isSystemUser = true;
      group = "talos-attest";
    };
    users.groups.talos-attest = { };
    # nginx reaches the public socket through the group; the admin socket admits only its owner.
    users.users.${config.services.nginx.user}.extraGroups = [ "talos-attest" ];

    systemd.services.talos-attest = {
      description = "Talos TPM attestation and LDevID issuance";
      wantedBy = [ "multi-user.target" ];
      wants = [ "network-online.target" ];
      after = [ "network-online.target" ];
      environment = {
        ATTEST_ADDR = "unix:${publicSocket}";
        ATTEST_ADMIN_ADDR = "unix:${adminSocket}";
        ATTEST_DEVID_ADDR = ":${toString devidPort}";
        ATTEST_APPROVERS = "jonathan@pulsifer.ca";
        ATTEST_CA_CHAIN = "${cfg.caChain}";
        ATTEST_EK_ROOTS = "${../../apps/talos-attest/roots}";
        ATTEST_POLICY = "${../../apps/talos-attest/policy.yaml}";
        ATTEST_INVENTORY = "${../../clusters/${site}/inventory/machines.yaml}";
        ATTEST_STATE_DIR = "/var/lib/talos-attest";
        ATTEST_PEERS = lib.concatStringsSep "," peers;
        ATTEST_METRICS_FILE = "${metricsDir}/talos-attest.prom";
      }
      // (
        if pkcs11 then
          {
            # The pkcs11signer contract (packages/pkcs11signer): the chain's first certificate picks the key.
            ATTEST_CA_PKCS11_MODULE = yubikey.pkcs11Module;
            ATTEST_CA_PKCS11_TOKEN = yubikey.tokenLabel;
            ATTEST_CA_PKCS11_PIN_FILE = "%d/devid-ca-pin";
            ATTEST_CA_CERT = "${cfg.caChain}";
          }
        else
          { ATTEST_CA_KEY = "%d/devid-ca-key"; }
      )
      // lib.optionalAttrs netbox {
        # NetBox runs on capsule (nix/services/netbox.nix) and serves the anchors on its Anchor
        # network address; the anchors are no tailnet peers of one another.
        ATTEST_NETBOX_URL = "http://${lab.hosts.capsule}:8080";
        ATTEST_NETBOX_TOKEN_FILE = "%d/netbox-token";
      };
      serviceConfig = {
        ExecStart = lib.getExe talos-attest;
        User = "talos-attest";
        Group = "talos-attest";
        LoadCredential = [
          (
            if pkcs11 then
              "devid-ca-pin:${yubikey.pinFile}"
            else
              "devid-ca-key:${config.sops.secrets."talos-attest/devid-ca-key".path}"
          )
        ]
        ++ lib.optional netbox "netbox-token:${config.sops.secrets."talos-attest/netbox-token".path}";
        StateDirectory = "talos-attest";
        StateDirectoryMode = "0750";
        RuntimeDirectory = "talos-attest";
        RuntimeDirectoryMode = "0750";
        ReadWritePaths = [ metricsDir ];
        UMask = "0027";
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

    systemd.services.talos-attest-tailscale-serve = {
      description = "Serve the talos-attest admin API on this anchor's tailnet name";
      wantedBy = [ "multi-user.target" ];
      wants = [ "tailscaled.service" ];
      after = [
        "tailscaled.service"
        "tailscaled-autoconnect.service"
        "talos-attest.service"
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

    # The bootstrap VLAN reaches the device flow through ./talos-boot.nix's port 80, at the boot VIP
    # and at this anchor's own bootstrap address.
    services.nginx.virtualHosts.talos-boot.locations."/attest/" = {
      proxyPass = "http://unix:${publicSocket}:/";
      extraConfig = ''
        proxy_set_header X-Forwarded-For $remote_addr;
        client_max_body_size 1m;
      '';
    };

    # Only folly's nodes and pods reach the DevID lookups, and only on the anchor network.
    networking.firewall.extraCommands = lib.concatMapStrings (cidr: ''
      iptables -A nixos-fw -i end0 -p tcp -s ${cidr} --dport ${toString devidPort} -j nixos-fw-accept
    '') devidSources;

    # Whether this anchor serves attestation. ./talos-boot.nix turns on node-exporter's textfile
    # collector for this directory; the service itself writes talos-attest.prom.
    systemd.services.talos-attest-check = {
      description = "Export whether this anchor serves talos-attest";
      serviceConfig = {
        Type = "oneshot";
        UMask = "0022";
        NoNewPrivileges = true;
        PrivateTmp = true;
        ProtectHome = true;
        ProtectSystem = "strict";
        ReadWritePaths = [ metricsDir ];
      };
      path = [ pkgs.coreutils ];
      script = ''
        set -u
        serving=0
        if ${serves}; then
          serving=1
        fi
        metrics=$(mktemp ${metricsDir}/.talos-attest-check.XXXXXX)
        trap 'rm -f "$metrics"' EXIT
        {
          printf '# HELP talos_attest_serving Whether talos-attest answers on its public socket.\n'
          printf '# TYPE talos_attest_serving gauge\n'
          printf 'talos_attest_serving{site="${site}"} %s\n' "$serving"
        } > "$metrics"
        chmod 0644 "$metrics"
        mv "$metrics" ${metricsDir}/talos-attest-check.prom
        trap - EXIT
      '';
    };

    systemd.timers.talos-attest-check = {
      description = "Periodically export whether this anchor serves talos-attest";
      wantedBy = [ "timers.target" ];
      timerConfig = {
        OnBootSec = "2m";
        OnUnitActiveSec = "1m";
        Unit = "talos-attest-check.service";
      };
    };
  };
}
