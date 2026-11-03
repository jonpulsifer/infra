# Tinkerbell on spore: the embedded binary runs kube-apiserver, etcd, Tink and Rufio for folly's
# Talos reprovisioning, and Smee when homelab.tinkerbell.smee.enable is on. Smee answers PXE as a
# proxy DHCP server on the bootstrap VLAN only, names the signed iPXE that dnsmasq serves over TFTP
# (./talos-boot.nix), serves each MAC's iPXE script on port 7080 and receives HookOS's syslog. With
# it off, UniFi's DHCP alone names the iPXE, the iPXE's own menu boots HookOS, and
# ./hookos-syslog.nix receives the syslog. With it on, homelab.tinkerbell.smee.dhcp turns the proxy
# offer off on its own, for a VLAN where Kea (./kea.nix) answers the relayed DHCP.
{
  config,
  lib,
  pkgs,
  ...
}:
let
  cfg = config.homelab.tinkerbell;
  lab = import ../lib/anchor.nix;
  site = config.homelab.site;
  iface = "bootstrap";
  bootstrapIp = lab.bootstrap.hosts.spore;

  # renovate: datasource=github-releases depName=tinkerbell/tinkerbell
  version = "v0.25.0";
  # tinkerbell-embedded-linux-arm64 in the release's checksums-embedded.txt. Renovate cannot update it.
  sha256 = "e76cac8bd46a5a4123c5ac87dae18e68b72f60b4eaa6e73247f1364c92382b16";

  # Under dnsmasq's TFTP root; Smee names it in its offer to UEFI x86-64 PXE clients (arch 7).
  ipxeFile = "talos/${site}/ipxe-amd64-secureboot.efi";
  # Some firmware (riptide's) takes Smee's ProxyDHCP offer over UniFi's. With allowPXE off, Smee
  # names /<mac>/netboot-not-allowed on spore's TFTP; fleetd (./fleetd.nix) links that path to the
  # same signed iPXE for each MAC NetBox holds, and the iPXE falls back to its own menu when Smee
  # has no script.
  # nginx's base for the signed HookOS UKI. Smee's default HookOS script reads it; a Hardware
  # object's netboot.ipxe.url replaces that script, so Secure Boot nodes never use it.
  osieUrl = "http://${bootstrapIp}/talos/${site}";

  apiPort = 6443;
  httpPort = 7080;
  tinkServerPort = 42113;
  syslogPort = 514;

  tinkerbell =
    pkgs.runCommand "tinkerbell-embedded-${version}"
      {
        src = pkgs.fetchurl {
          name = "tinkerbell-embedded-linux-arm64-${version}";
          url = "https://github.com/tinkerbell/tinkerbell/releases/download/${version}/tinkerbell-embedded-linux-arm64";
          inherit sha256;
        };
        meta.mainProgram = "tinkerbell";
      }
      ''
        install -Dm755 $src $out/bin/tinkerbell
      '';

  credentials = "/run/credentials/tinkerbell.service";
  # The enrollment name's public certificate (./fleetd.nix): the Tink server presents it to
  # HookOS's agent, whose signed command line names it and sets tinkerbell_tls=true, so a host on
  # the Kubernetes network cannot stand in for the server and hand the agent actions.
  enrollHost = "enroll.${(import ../lib/fleet.nix).dnsZone}";
  acmeDir = config.security.acme.certs.${enrollHost}.directory;
  secrets = [
    "ca-crt"
    "server-crt"
    "server-key"
    "admin-crt"
    "admin-key"
    "service-account-key"
  ];

  # Flux on folly applies the objects in clusters/folly/tinkerbell/ to this namespace, as the client
  # certificate CN that scripts/tinkerbell-certs.sh --client issues. RBAC cannot be bootstrapped by
  # the identity it authorizes, so tinkerbell-rbac applies it with the admin certificate. Git holds
  # the Template and the BMC Secrets, so those are the kinds Flux may write; fleetd (./fleetd.nix)
  # owns the Hardware, Machine and Workflow objects with the admin certificate, and Flux only reads
  # them. A Template decides what HookOS runs as root, so a compromise of folly reaches that far and
  # no further.
  namespace = "tinkerbell";
  fluxUser = "folly-flux";
  manage = [
    "get"
    "list"
    "watch"
    "create"
    "update"
    "patch"
    "delete"
  ];
  rbac = pkgs.writeText "tinkerbell-rbac.json" (
    builtins.toJSON {
      apiVersion = "v1";
      kind = "List";
      items = [
        {
          apiVersion = "v1";
          kind = "Namespace";
          metadata.name = namespace;
        }
        {
          apiVersion = "rbac.authorization.k8s.io/v1";
          kind = "Role";
          metadata = {
            name = fluxUser;
            inherit namespace;
          };
          rules = [
            {
              apiGroups = [ "tinkerbell.org" ];
              resources = [ "templates" ];
              verbs = manage;
            }
            {
              apiGroups = [ "" ];
              resources = [ "secrets" ];
              verbs = manage;
            }
            {
              apiGroups = [
                "tinkerbell.org"
                "bmc.tinkerbell.org"
              ];
              resources = [
                "hardware"
                "workflows"
                "machines"
              ];
              verbs = [
                "get"
                "list"
                "watch"
              ];
            }
          ];
        }
        {
          apiVersion = "rbac.authorization.k8s.io/v1";
          kind = "RoleBinding";
          metadata = {
            name = fluxUser;
            inherit namespace;
          };
          roleRef = {
            apiGroup = "rbac.authorization.k8s.io";
            kind = "Role";
            name = fluxUser;
          };
          subjects = [
            {
              apiGroup = "rbac.authorization.k8s.io";
              kind = "User";
              name = fluxUser;
            }
          ];
        }
      ];
    }
  );

  applyRbac = pkgs.writeShellApplication {
    name = "tinkerbell-rbac";
    runtimeInputs = [ pkgs.kubectl ];
    text = ''
      k() {
        kubectl --server=https://localhost:${toString apiPort} \
          --certificate-authority="$CREDENTIALS_DIRECTORY/ca-crt" \
          --client-certificate="$CREDENTIALS_DIRECTORY/admin-crt" \
          --client-key="$CREDENTIALS_DIRECTORY/admin-key" "$@"
      }
      for _ in $(seq 60); do
        k get --raw /readyz >/dev/null 2>&1 && break
        sleep 5
      done
      k apply --server-side --field-manager=nixos --force-conflicts -f ${rbac}
    '';
  };

  # Tinkerbell's own services reach the API as system:masters through this file, and root on spore
  # through /etc/tinkerbell/kubeconfig, which reads the same certificates from sops-nix.
  kubeconfigFrom =
    dir:
    pkgs.writeText "tinkerbell-kubeconfig.json" (
      builtins.toJSON {
        apiVersion = "v1";
        kind = "Config";
        clusters = [
          {
            name = "tinkerbell";
            cluster = {
              server = "https://localhost:${toString apiPort}";
              certificate-authority = "${dir}/ca-crt";
            };
          }
        ];
        users = [
          {
            name = "tinkerbell-admin";
            user = {
              client-certificate = "${dir}/admin-crt";
              client-key = "${dir}/admin-key";
            };
          }
        ];
        contexts = [
          {
            name = "tinkerbell";
            context = {
              cluster = "tinkerbell";
              user = "tinkerbell-admin";
            };
          }
        ];
        current-context = "tinkerbell";
      }
    );
  kubeconfig = kubeconfigFrom credentials;

  flags = [
    "--backend-kube-config=${kubeconfig}"
    "--etcd-dir=%S/tinkerbell/etcd"
    "--etcd-servers=http://localhost:2379"
    # Every address, so localhost serves the kubeconfig above; the firewall admits the Anchor network and the tailnet.
    "--kube-apiserver-bind-address=0.0.0.0"
    "--secure-port=${toString apiPort}"
    "--kube-apiserver-tls-cert-file=%d/server-crt"
    "--kube-apiserver-tls-private-key-file=%d/server-key"
    "--client-ca-file=%d/ca-crt"
    "--service-account-key-file=%d/service-account-key"
    "--service-account-signing-key-file=%d/service-account-key"
    "--service-account-issuer=https://kubernetes.default.svc"
    # The apiserver defaults to AlwaysAllow with anonymous requests on.
    "--anonymous-auth=false"
    "--authorization-mode=RBAC"

    # TLS on the Tink server's gRPC port. The same flags start an HTTPS copy of Smee's HTTP on
    # 7443, which no firewall rule admits.
    "--tls-cert-file=%d/tls-crt"
    "--tls-key-file=%d/tls-key"
    "--ipxe-script-tink-server-use-tls=true"

    "--enable-smee=${lib.boolToString cfg.smee.enable}"
    "--enable-ui=false"
    "--enable-tootles=false"
    "--enable-secondstar=false"
    "--public-ipv4=${bootstrapIp}"
    "--bind-address=${bootstrapIp}"
    "--http-port=${toString httpPort}"
    "--tink-server-bind-addr=${bootstrapIp}"
    "--tink-server-bind-port=${toString tinkServerPort}"
    # HookOS sends its syslog to syslog_host= on its command line; Smee writes it to the journal.
    "--syslog-enabled=true"
    "--syslog-bind-addr=${bootstrapIp}"
    "--syslog-bind-port=${toString syslogPort}"

    # proxy answers only MACs that have a Hardware object; UniFi leases the address.
    "--dhcp-enabled=${lib.boolToString cfg.smee.dhcp}"
    "--dhcp-mode=proxy"
    "--dhcp-bind-interface=${iface}"
    # A Smee TFTP listener collides with dnsmasq's and stops Smee answering at all.
    "--tftp-server-enabled=false"
    "--dhcp-tftp-ip=${bootstrapIp}"
    "--ipxe-override-arch-mapping=7=${ipxeFile}"
    # Smee's own iPXE binaries are unsigned; Secure Boot nodes boot only ours.
    "--ipxe-http-binary-enabled=false"
    "--ipxe-http-script-osie-url=${osieUrl}"
  ];
in
{
  options.homelab.tinkerbell.smee = {
    enable = lib.mkOption {
      type = lib.types.bool;
      default = true;
      description = "Run Smee: the proxy DHCP offer, the per-MAC iPXE script on port 7080 and the syslog receiver on the bootstrap VLAN.";
    };
    dhcp = lib.mkOption {
      type = lib.types.bool;
      default = true;
      description = "Whether a running Smee answers PXE on the bootstrap VLAN as a proxy DHCP server. Off where Kea (./kea.nix) answers the Kubernetes network's DHCP, so one server names the boot file.";
    };
  };

  config = {
    assertions = [
      {
        assertion = pkgs.stdenv.hostPlatform.system == "aarch64-linux";
        message = "tinkerbell.nix pins only the arm64 release binary.";
      }
      {
        assertion = config.networking.vlans ? ${iface};
        message = "tinkerbell.nix binds to the ${iface} VLAN, which talos-boot.nix declares.";
      }
    ];

    sops.secrets = lib.genAttrs (map (name: "tinkerbell/${name}") secrets) (_: {
      restartUnits = [ "tinkerbell.service" ];
    });

    # 10257 (the embedded controller manager) listens on every address and has no flag, so no rule admits it.
    # The HTTP port stays bound with Smee off, for the binary's health and metrics; nothing on the VLAN needs it then.
    networking.firewall.interfaces = {
      ${iface} = {
        allowedTCPPorts = lib.optional cfg.smee.enable httpPort ++ [ tinkServerPort ];
        allowedUDPPorts =
          lib.optional (cfg.smee.enable && cfg.smee.dhcp) 67 ++ lib.optional cfg.smee.enable syslogPort;
      };
      end0.allowedTCPPorts = [ apiPort ];
      tailscale0.allowedTCPPorts = [ apiPort ];
    };

    environment.systemPackages = [
      tinkerbell
      pkgs.kubectl
    ];
    environment.etc."tinkerbell/kubeconfig".source = kubeconfigFrom (
      dirOf config.sops.secrets."tinkerbell/ca-crt".path
    );

    systemd.services.tinkerbell = {
      description = "Tinkerbell bare-metal provisioning";
      wantedBy = [ "multi-user.target" ];
      requires = [ "sys-subsystem-net-devices-${iface}.device" ];
      after = [
        "network-online.target"
        "sys-subsystem-net-devices-${iface}.device"
        "acme-${enrollHost}.service"
      ];
      wants = [
        "network-online.target"
        "acme-${enrollHost}.service"
      ];
      # Tinkerbell exits when its apiserver is not healthy within 20s; keep retrying until it is.
      startLimitIntervalSec = 0;
      environment.HOME = "%S/tinkerbell";
      serviceConfig = {
        ExecStart = "${lib.getExe tinkerbell} ${lib.concatStringsSep " " flags}";
        Restart = "on-failure";
        RestartSec = "15s";
        LoadCredential = map (name: "${name}:${config.sops.secrets."tinkerbell/${name}".path}") secrets ++ [
          "tls-crt:${acmeDir}/fullchain.pem"
          "tls-key:${acmeDir}/key.pem"
        ];
        DynamicUser = true;
        StateDirectory = "tinkerbell";
        StateDirectoryMode = "0700";
        WorkingDirectory = "%S/tinkerbell";
        UMask = "0077";
        AmbientCapabilities = [
          "CAP_NET_BIND_SERVICE"
          "CAP_NET_RAW"
        ];
        CapabilityBoundingSet = [
          "CAP_NET_BIND_SERVICE"
          "CAP_NET_RAW"
        ];
        NoNewPrivileges = true;
        PrivateTmp = true;
        PrivateDevices = true;
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
          "AF_NETLINK"
        ];
        RestrictNamespaces = true;
        RestrictRealtime = true;
        RestrictSUIDSGID = true;
        LockPersonality = true;
        MemoryDenyWriteExecute = true;
        SystemCallArchitectures = "native";
        SystemCallFilter = [ "@system-service" ];
        SystemCallErrorNumber = "EPERM";
      };
    };

    # Re-applies the namespace and Flux's Role whenever Tinkerbell starts, so a wiped etcd gets them back.
    systemd.services.tinkerbell-rbac = {
      description = "Namespace and RBAC for Flux on folly in Tinkerbell's API";
      wantedBy = [
        "multi-user.target"
        "tinkerbell.service"
      ];
      partOf = [ "tinkerbell.service" ];
      after = [ "tinkerbell.service" ];
      environment.HOME = "/tmp";
      serviceConfig = {
        Type = "oneshot";
        RemainAfterExit = true;
        ExecStart = lib.getExe applyRbac;
        Restart = "on-failure";
        RestartSec = "30s";
        LoadCredential = map (name: "${name}:${config.sops.secrets."tinkerbell/${name}".path}") [
          "ca-crt"
          "admin-crt"
          "admin-key"
        ];
        DynamicUser = true;
        UMask = "0077";
        CapabilityBoundingSet = "";
        NoNewPrivileges = true;
        PrivateTmp = true;
        PrivateDevices = true;
        ProtectHome = true;
        ProtectSystem = "strict";
        ProtectKernelTunables = true;
        ProtectKernelModules = true;
        ProtectControlGroups = true;
        RestrictAddressFamilies = [
          "AF_UNIX"
          "AF_INET"
          "AF_INET6"
        ];
        RestrictNamespaces = true;
        LockPersonality = true;
        SystemCallArchitectures = "native";
        SystemCallFilter = [ "@system-service" ];
      };
    };
  };
}
