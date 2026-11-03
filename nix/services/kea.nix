# Kea DHCPv4 on spore for folly's Kubernetes network. The UDM relays the network's DHCP to spore's
# bootstrap address (terraform/network/unifi/folly/k8s.tf), and Kea answers through it: the netboot
# pool K8S_DHCP_CIDR, and the signed iPXE's name for PXE firmware, which dnsmasq serves over TFTP
# (./talos-boot.nix). Kea opens a UDP socket, which answers relayed traffic only, so a machine on
# the bootstrap VLAN itself gets nothing from it. Smee's proxy offer is off while Kea is on
# (./tinkerbell.nix). fleetd (./fleetd.nix) owns the reservations file Kea includes.
{
  config,
  lib,
  pkgs,
  name,
  ...
}:
let
  cfg = config.homelab.kea;
  lab = import ../lib/anchor.nix;
  fleet = import ../lib/fleet.nix;
  site = config.homelab.site;
  topology = (lib.importJSON ../../clusters/${site}/config/cluster-topology.json).data;
  iface = "bootstrap";
  address = lab.bootstrap.hosts.spore;
  stateDir = "/var/lib/kea";
  # A JSON array of host reservations. fleetd (./fleetd.nix), in group kea, rewrites it in this
  # group-writable, setgid directory and asks Kea to reload over the control socket; an empty array
  # is seeded so Kea starts before fleetd has written one.
  fleetDir = "${stateDir}/fleet";
  reservationsFile = "${fleetDir}/reservations.json";
  # Kea 3 accepts a control socket only under its socket directory, /run/kea. The unit's umask
  # gives the socket kea:kea 0770, and the tmpfiles rule below owns the directory: systemd's
  # dynamic-user release left it nobody's when the unit moved to its static user, and the
  # RuntimeDirectory migration keeps that ownership, so without the rule no other user connects.
  runDir = "/run/kea";
  socket = "${runDir}/kea-dhcp4.socket";
  metricsDir = "/var/lib/prometheus-node-exporter-text-files";
  # Under dnsmasq's TFTP root (./talos-boot.nix), the name UniFi's boot option carries today.
  ipxe = "talos/${site}/ipxe-amd64-secureboot.efi";

  # The pool as k8s.tf takes it from K8S_DHCP_CIDR: the first host to the last host but one.
  ipToInt = ip: lib.foldl (acc: octet: acc * 256 + lib.toInt octet) 0 (lib.splitString "." ip);
  intToIp =
    n:
    lib.concatMapStringsSep "." toString [
      (n / 16777216)
      (lib.mod (n / 65536) 256)
      (lib.mod (n / 256) 256)
      (lib.mod n 256)
    ];
  pow2 = n: if n == 0 then 1 else 2 * pow2 (n - 1);
  pool =
    let
      parts = lib.splitString "/" topology.K8S_DHCP_CIDR;
      size = pow2 (32 - lib.toInt (lib.last parts));
      base = (ipToInt (lib.head parts) / size) * size;
    in
    "${intToIp (base + 1)} - ${intToIp (base + size - 2)}";

  dhcp4 = {
    interfaces-config = {
      interfaces = [ "${iface}/${address}" ];
      # UDP sockets take relayed traffic only: no broadcast from a machine on the VLAN is heard.
      dhcp-socket-type = "udp";
      service-sockets-require-all = true;
      service-sockets-max-retries = 20;
      service-sockets-retry-wait-time = 5000;
    };
    control-sockets = [
      {
        socket-type = "unix";
        socket-name = socket;
      }
    ];
    lease-database = {
      type = "memfile";
      persist = true;
      name = "${stateDir}/dhcp4.leases";
      lfc-interval = 3600;
    };
    authoritative = true;
    # One day, as the UDM leases today.
    valid-lifetime = 86400;
    # A reservation is a node's or an AMT's declared address, never one from the pool.
    reservations-out-of-pool = true;
    host-reservation-identifiers = [ "hw-address" ];
    # One NIC sends several client identifiers across a boot: PXE firmware and HookOS the MAC,
    # an installed NixOS a DUID, an AMT none. A lease is per MAC, so the installed OS renews the
    # reserved address instead of losing it to the boot's lease and taking a pool address.
    match-client-id = false;
    # The same unconditional offer UniFi makes: PXE firmware fetches the signed iPXE from spore.
    next-server = address;
    boot-file-name = ipxe;
    option-data = [
      {
        name = "domain-name-servers";
        data = "${lab.ns.ns1}, ${lab.ns.ns2}";
      }
      {
        name = "domain-name";
        data = fleet.dnsZone;
      }
    ];
    subnet4 = [
      {
        id = 1;
        subnet = topology.K8S_NODE_CIDR;
        pools = [ { inherit pool; } ];
        option-data = [
          {
            name = "routers";
            data = topology.ROUTER_IP;
          }
        ];
        relay.ip-addresses = [ topology.ROUTER_IP ];
        reservations = "@RESERVATIONS@";
      }
    ];
    loggers = [
      {
        name = "kea-dhcp4";
        severity = "INFO";
        output-options = [ { output = "stdout"; } ];
      }
    ];
  };
  # Kea's preprocessor splices the reservations file in where the placeholder stands, so a reload
  # picks up fleetd's latest write without a rebuild.
  configFile = pkgs.writeText "kea-dhcp4.conf" (
    lib.replaceStrings [ ''"@RESERVATIONS@"'' ] [ ''<?include "${reservationsFile}"?>'' ] (
      builtins.toJSON { Dhcp4 = dhcp4; }
    )
  );

  command = "${pkgs.socat}/bin/socat -T 5 - UNIX-CONNECT:${socket},ignoreeof";
in
{
  options.homelab.kea = {
    enable = lib.mkOption {
      type = lib.types.bool;
      default = false;
      description = "Run Kea DHCPv4 for the Kubernetes network on this host's bootstrap address.";
    };
  };

  config = lib.mkIf cfg.enable {
    assertions = [
      {
        assertion = lab.bootstrap.hosts ? ${name};
        message = "kea.nix may only be enabled on a host with a bootstrap address: ${lib.concatStringsSep ", " (lib.attrNames lab.bootstrap.hosts)}";
      }
      {
        assertion = config.networking.vlans ? ${iface};
        message = "kea.nix binds to the ${iface} VLAN, which talos-boot.nix declares.";
      }
    ];

    services.kea.dhcp4 = {
      enable = true;
      inherit configFile;
    };

    # A static user in place of the module's DynamicUser, so /var/lib/kea and /run/kea are plain
    # directories that fleetd, in group kea, reaches for the reservations file and the control
    # socket. With DynamicUser they are symlinks into /var/lib/private and /run/private, which only
    # root traverses.
    users.users.kea = {
      isSystemUser = true;
      group = "kea";
      description = "Kea DHCP server";
    };
    users.groups.kea = { };

    # The relay's requests arrive on the VLAN from the gateway. ./talos-boot.nix's chain admits
    # what this interface declares.
    networking.firewall.interfaces.${iface}.allowedUDPPorts = [ 67 ];

    systemd.tmpfiles.rules = [
      "d ${runDir} 0750 kea kea -"
      "d ${stateDir} 0750 kea kea -"
      "d ${fleetDir} 2770 kea kea -"
      "f ${reservationsFile} 0660 kea kea - []"
    ];

    systemd.services.kea-dhcp4-server = {
      requires = [ "sys-subsystem-net-devices-${iface}.device" ];
      after = [ "sys-subsystem-net-devices-${iface}.device" ];
      serviceConfig = {
        DynamicUser = lib.mkForce false;
        # The control socket takes the umask, so group kea (fleetd) can connect to it.
        UMask = lib.mkForce "0007";
        RuntimeDirectoryMode = "0750";
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
        SystemCallArchitectures = "native";
        SystemCallFilter = [ "@system-service" ];
        SystemCallErrorNumber = "EPERM";
      };
    };

    # Whether Kea answers, and how many acknowledgements it has sent. The cluster cannot reach the
    # bootstrap VLAN, so node-exporter carries them, as ./talos-boot.nix's check does.
    systemd.services.kea-check = {
      description = "Export whether Kea answers on spore's control socket";
      path = with pkgs; [
        coreutils
        jq
        systemd
      ];
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
      script = ''
        set -u
        serving=0
        acks=0
        if systemctl is-active --quiet kea-dhcp4-server.service; then
          status=$(echo '{"command":"status-get"}' | ${command} 2>/dev/null || true)
          if [ "$(printf '%s' "$status" | jq -r '.result // 1' 2>/dev/null)" = "0" ]; then
            serving=1
            acks=$(echo '{"command":"statistic-get","arguments":{"name":"pkt4-ack-sent"}}' \
              | ${command} 2>/dev/null \
              | jq -r '.arguments["pkt4-ack-sent"][0][0] // 0' 2>/dev/null || echo 0)
          fi
        fi
        metrics=$(mktemp ${metricsDir}/.kea-check.XXXXXX)
        trap 'rm -f "$metrics"' EXIT
        {
          printf '# HELP kea_dhcp4_serving Whether Kea runs on spore and answers status-get on its control socket.\n'
          printf '# TYPE kea_dhcp4_serving gauge\n'
          printf 'kea_dhcp4_serving{site="${site}"} %s\n' "$serving"
          printf '# HELP kea_dhcp4_acks_total DHCPACKs Kea has sent since it started.\n'
          printf '# TYPE kea_dhcp4_acks_total counter\n'
          printf 'kea_dhcp4_acks_total{site="${site}"} %s\n' "$acks"
        } > "$metrics"
        chmod 0644 "$metrics"
        mv "$metrics" ${metricsDir}/kea-check.prom
        trap - EXIT
      '';
    };

    systemd.timers.kea-check = {
      description = "Periodically export Kea's state";
      wantedBy = [ "timers.target" ];
      timerConfig = {
        OnBootSec = "2m";
        OnUnitActiveSec = "1m";
        Unit = "kea-check.service";
      };
    };
  };
}
