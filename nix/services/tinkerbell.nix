# Tinkerbell on spore: the embedded binary runs kube-apiserver, etcd, Smee, Tink and Rufio for folly's
# Talos reprovisioning. Smee answers PXE as a proxy DHCP server on the bootstrap VLAN only and names
# the signed iPXE that dnsmasq serves over TFTP (./pxe-netboot.nix).
{
  config,
  lib,
  pkgs,
  ...
}:
let
  lab = import ../lib/lab.nix;
  iface = "bootstrap";
  bootstrapIp = lab.bootstrap.spore;

  # renovate: datasource=github-releases depName=tinkerbell/tinkerbell
  version = "v0.25.0";
  # tinkerbell-embedded-linux-arm64 in the release's checksums-embedded.txt. Renovate cannot update it.
  sha256 = "e76cac8bd46a5a4123c5ac87dae18e68b72f60b4eaa6e73247f1364c92382b16";

  # Under dnsmasq's TFTP root; Smee names it in its offer to UEFI x86-64 PXE clients (arch 7).
  ipxeFile = "talos/folly/ipxe-amd64-secureboot.efi";
  # nginx's base for the signed HookOS UKI. Smee's default HookOS script reads it; a Hardware
  # object's netboot.ipxe.url replaces that script, so Secure Boot nodes never use it.
  osieUrl = "http://${bootstrapIp}/talos/folly";

  apiPort = 6443;
  httpPort = 7080;
  tinkServerPort = 42113;

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
  secrets = [
    "ca-crt"
    "server-crt"
    "server-key"
    "admin-crt"
    "admin-key"
    "service-account-key"
  ];

  # Tinkerbell's own services reach the API as system:masters through this file.
  kubeconfig = pkgs.writeText "tinkerbell-kubeconfig.json" (
    builtins.toJSON {
      apiVersion = "v1";
      kind = "Config";
      clusters = [
        {
          name = "tinkerbell";
          cluster = {
            server = "https://localhost:${toString apiPort}";
            certificate-authority = "${credentials}/ca-crt";
          };
        }
      ];
      users = [
        {
          name = "tinkerbell-admin";
          user = {
            client-certificate = "${credentials}/admin-crt";
            client-key = "${credentials}/admin-key";
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

  flags = [
    "--backend-kube-config=${kubeconfig}"
    "--etcd-dir=%S/tinkerbell/etcd"
    "--etcd-servers=http://localhost:2379"
    # Every address, so localhost serves the kubeconfig above; the firewall admits Lab Net and the tailnet.
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

    "--enable-ui=false"
    "--enable-tootles=false"
    "--enable-secondstar=false"
    "--public-ipv4=${bootstrapIp}"
    "--bind-address=${bootstrapIp}"
    "--http-port=${toString httpPort}"
    "--tink-server-bind-addr=${bootstrapIp}"
    "--tink-server-bind-port=${toString tinkServerPort}"
    "--syslog-enabled=false"

    # proxy answers only MACs that have a Hardware object; UniFi leases the address.
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
  assertions = [
    {
      assertion = pkgs.stdenv.hostPlatform.system == "aarch64-linux";
      message = "tinkerbell.nix pins only the arm64 release binary.";
    }
    {
      assertion = config.networking.vlans ? ${iface};
      message = "tinkerbell.nix binds Smee to the ${iface} VLAN, which spore-talos-boot.nix declares.";
    }
  ];

  sops.secrets = lib.genAttrs (map (name: "tinkerbell/${name}") secrets) (_: {
    restartUnits = [ "tinkerbell.service" ];
  });

  # 10257 (the embedded controller manager) listens on every address and has no flag, so no rule admits it.
  networking.firewall.interfaces = {
    ${iface} = {
      allowedTCPPorts = [
        httpPort
        tinkServerPort
      ];
      allowedUDPPorts = [ 67 ];
    };
    end0.allowedTCPPorts = [ apiPort ];
    tailscale0.allowedTCPPorts = [ apiPort ];
  };

  environment.systemPackages = [ tinkerbell ];

  systemd.services.tinkerbell = {
    description = "Tinkerbell bare-metal provisioning";
    wantedBy = [ "multi-user.target" ];
    requires = [ "sys-subsystem-net-devices-${iface}.device" ];
    after = [
      "network-online.target"
      "sys-subsystem-net-devices-${iface}.device"
    ];
    wants = [ "network-online.target" ];
    # Tinkerbell exits when its apiserver is not healthy within 20s; keep retrying until it is.
    startLimitIntervalSec = 0;
    environment.HOME = "%S/tinkerbell";
    serviceConfig = {
      ExecStart = "${lib.getExe tinkerbell} ${lib.concatStringsSep " " flags}";
      Restart = "on-failure";
      RestartSec = "15s";
      LoadCredential = map (name: "${name}:${config.sops.secrets."tinkerbell/${name}".path}") secrets;
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
}
