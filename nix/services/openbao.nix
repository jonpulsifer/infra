# OpenBao on an anchor: the lab's online CA and secrets server, with Raft storage on the host and
# an auto-unseal key in the host's YubiKey (./yubikey-piv.nix), so a restart unseals with no cloud
# and no cluster. docs/platform/secrets.md has the design and docs/runbooks/initialize-openbao.md the
# first start.
{
  config,
  lib,
  pkgs,
  ...
}:
let
  cfg = config.homelab.openbao;
  yubikey = config.homelab.yubikey;
  fleet = import ../lib/fleet.nix;
  lab = import ../lib/anchor.nix;
  folly = (import ../lib/networks.nix).folly;
  hostName = config.networking.hostName;
  host = "${hostName}.${fleet.dnsZone}";
  acmeDir = config.security.acme.certs.${host}.directory;
  stateDir = "/var/lib/openbao";
  pinCredential = "piv-pin";
  settingsFormat = pkgs.formats.json { };
  configFile = settingsFormat.generate "openbao.hcl.json" config.services.openbao.settings;
  # The seal reads the PIN from BAO_HSM_PIN; the config file is in the store, so the PIN cannot go
  # there. systemd hands the unit the PIN as a credential and this shim exports it.
  start = pkgs.writeShellScript "openbao-start" ''
    BAO_HSM_PIN="$(cat "$CREDENTIALS_DIRECTORY/${pinCredential}")"
    export BAO_HSM_PIN
    exec ${lib.getExe config.services.openbao.package} server -config ${configFile}
  '';
in
{
  imports = [ ./openbao-config.nix ];

  options.homelab.openbao = {
    enable = lib.mkEnableOption "OpenBao on this anchor, sealed by its YubiKey";

    port = lib.mkOption {
      type = lib.types.port;
      default = 8200;
      description = "The API and UI port. Metrics are served on it too, at /v1/sys/metrics.";
    };

    clusterPort = lib.mkOption {
      type = lib.types.port;
      default = 8201;
      description = "The Raft port, open to the other anchors only.";
    };

    clientSources = lib.mkOption {
      type = lib.types.listOf lib.types.str;
      default = [
        lab.cidr
        folly.nodeCidr
        folly.podCidr
      ];
      defaultText = "the Anchor network and folly's node and pod CIDRs";
      description = "The CIDRs that reach the API. The tailnet reaches it too, for the owner.";
    };

    unsealKeyLabel = lib.mkOption {
      type = lib.types.str;
      default = "Private key for Key Management";
      description = "The CKA_LABEL ykcs11 gives the RSA key in PIV slot 9d, which wraps the barrier key.";
    };

    unsealKeyId = lib.mkOption {
      type = lib.types.str;
      default = "0x03";
      description = "The CKA_ID of that key: ykcs11 numbers slot 9d 03.";
    };
  };

  config = lib.mkIf cfg.enable {
    assertions = [
      {
        assertion = yubikey.enable && yubikey.serial != null;
        message = "homelab.openbao needs homelab.yubikey.enable and the card's serial: run `mise run openbao:yubikey:init ${hostName}` first";
      }
    ];

    services.openbao = {
      enable = true;
      settings = {
        ui = true;
        api_addr = "https://${host}:${toString cfg.port}";
        cluster_addr = "https://${lab.hosts.${hostName}}:${toString cfg.clusterPort}";
        storage.raft = {
          path = stateDir;
          node_id = hostName;
        };
        listener.default = {
          type = "tcp";
          address = "0.0.0.0:${toString cfg.port}";
          cluster_address = "${lab.hosts.${hostName}}:${toString cfg.clusterPort}";
          tls_cert_file = "${acmeDir}/fullchain.pem";
          tls_key_file = "${acmeDir}/key.pem";
          tls_min_version = "tls12";
          # Prometheus on folly scrapes /v1/sys/metrics with no token.
          telemetry.unauthenticated_metrics_access = true;
        };
        seal.pkcs11 = {
          lib = yubikey.pkcs11Module;
          token_label = yubikey.tokenLabel;
          key_label = cfg.unsealKeyLabel;
          key_id = cfg.unsealKeyId;
          mechanism = "RSA_PKCS_OAEP";
          rsa_oaep_hash = "sha256";
        };
        telemetry = {
          prometheus_retention_time = "24h";
          disable_hostname = true;
        };
      };
    };

    # The nixpkgs unit runs a DynamicUser, whose supplementary groups polkit does not see when
    # pcscd asks it about the card. A static user in the yubikey group is what fleetd does on spore.
    users.users.openbao = {
      isSystemUser = true;
      group = "openbao";
      extraGroups = [ "yubikey" ];
    };
    users.groups.openbao = { };

    # The name needs a public certificate: kubelet, cert-manager and the owner's browser trust
    # only public roots, and the lab's own chain is what this server issues. The address is
    # private, so the challenge is DNS-01.
    security.acme = {
      acceptTerms = true;
      certs.${host} = {
        dnsProvider = "cloudflare";
        dnsResolver = "1.1.1.1:53";
        credentialFiles.CLOUDFLARE_DNS_API_TOKEN_FILE = config.sops.secrets."acme/cloudflare-token".path;
        group = "openbao";
        # SIGHUP makes the listener read the renewed certificate.
        reloadServices = [ "openbao.service" ];
      };
    };
    sops.secrets."acme/cloudflare-token" = { };

    systemd.services.openbao = {
      # The seal unseals the server on its own, so a config change may restart it.
      restartIfChanged = lib.mkForce true;
      wants = [
        "network-online.target"
        "pcscd.service"
        "acme-${host}.service"
      ];
      after = [
        "network-online.target"
        "pcscd.service"
        "acme-${host}.service"
      ];
      serviceConfig = {
        DynamicUser = lib.mkForce false;
        ExecStart = lib.mkForce start;
        LoadCredential = [ "${pinCredential}:${yubikey.pinFile}" ];
        StateDirectoryMode = lib.mkForce "0700";
      };
    };

    # The CLI on the host talks to this server.
    environment.variables.BAO_ADDR = "https://${host}:${toString cfg.port}";

    networking.firewall = {
      interfaces.tailscale0.allowedTCPPorts = [ cfg.port ];
      extraCommands =
        lib.concatMapStrings (cidr: ''
          iptables -A nixos-fw -p tcp -s ${cidr} --dport ${toString cfg.port} -j nixos-fw-accept
        '') cfg.clientSources
        + ''
          iptables -A nixos-fw -p tcp -s ${lab.cidr} --dport ${toString cfg.clusterPort} -j nixos-fw-accept
        '';
    };
  };
}
