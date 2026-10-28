# The anchors' shared addresses. ns1 and ns2 carry DNS and NTP on the Anchor network, and s3 carries the
# Garage S3 API (./garage.nix); boot carries the Talos boot files on the bootstrap VLAN
# (./talos-boot.nix). keepalived on every anchor runs unicast VRRP
# for each. Each VIP prefers its own order of anchors, and an anchor whose service stops answering
# drops below every healthy one, so the VIP follows a working server.
{
  lib,
  pkgs,
  name,
  ...
}:
let
  lab = import ../lib/anchor.nix;
  backups = import ../lib/backups.nix { inherit pkgs; };
  anchors = [
    "capsule"
    "forge"
    "spore"
  ];
  others = lib.remove name anchors;
  prefixOf = cidr: lib.last (lib.splitString "/" cidr);
  networks = {
    lab = {
      interface = "end0";
      hosts = lab.hosts;
      prefix = prefixOf lab.cidr;
    };
    bootstrap = {
      interface = "bootstrap";
      hosts = lab.bootstrap.hosts;
      prefix = prefixOf lab.bootstrap.cidr;
    };
  };
  peersOn = network: map (anchor: network.hosts.${anchor}) others;
  vips = {
    ns1 = {
      routerId = 53;
      network = networks.lab;
      addr = lab.ns.ns1;
      track = "coredns";
      order = [
        "capsule"
        "forge"
        "spore"
      ];
    };
    ns2 = {
      routerId = 54;
      network = networks.lab;
      addr = lab.ns.ns2;
      track = "coredns";
      order = [
        "forge"
        "spore"
        "capsule"
      ];
    };
    # capsule first: its Garage data sits on NVMe, and spore, last, already serves NFS and Smee.
    s3 = {
      routerId = 55;
      network = networks.lab;
      addr = lab.s3Vip;
      track = "garage";
      order = [
        "capsule"
        "forge"
        "spore"
      ];
    };
    # spore first, beside Smee, which the netboot iPXE chains at spore's own address.
    boot = {
      routerId = 69;
      network = networks.bootstrap;
      addr = lab.bootstrap.vip;
      track = "talos-boot";
      order = [
        "spore"
        "capsule"
        "forge"
      ];
    };
  };
  # 150, 100 and 50 down the order. A failed check takes 120 off, below the lowest healthy anchor.
  priority = order: 150 - 50 * lib.lists.findFirstIndex (anchor: anchor == name) 2 order;
  # CoreDNS answers localhost from /etc/hosts through its hosts plugin, with no upstream involved.
  # /etc/hosts lists it more than once, so match a line.
  corednsAnswers = pkgs.writeShellScript "anchor-coredns-answers" ''
    ${pkgs.dnsutils}/bin/dig +short +time=1 +tries=1 @127.0.0.1 localhost A | ${pkgs.gnugrep}/bin/grep -qx 127.0.0.1
  '';
  # Garage's admin /health answers 200 only while enough nodes are up for a quorum, and the S3
  # port must answer too. Any HTTP status proves the S3 API listens: unsigned requests get 403.
  garageAnswers = pkgs.writeShellScript "anchor-garage-answers" ''
    ${pkgs.curl}/bin/curl --fail --silent --output /dev/null --max-time 2 http://127.0.0.1:3903/health
    [ "$(${pkgs.curl}/bin/curl --silent --output /dev/null --max-time 2 --write-out '%{http_code}' http://127.0.0.1:${toString backups.s3Port}/)" != 000 ]
  '';
  metricsDir = "/var/lib/prometheus-node-exporter-text-files";
in
{
  services.keepalived = {
    enable = true;
    enableScriptSecurity = true;
    vrrpScripts.coredns = {
      script = toString corednsAnswers;
      interval = 2;
      fall = 2;
      rise = 2;
      weight = -120;
      user = "nobody";
    };
    vrrpScripts.garage = {
      script = toString garageAnswers;
      interval = 5;
      fall = 2;
      rise = 2;
      weight = -120;
      user = "nobody";
    };
    vrrpInstances = lib.mapAttrs (vip: v: {
      inherit (v.network) interface;
      state = "BACKUP";
      virtualRouterId = v.routerId;
      priority = priority v.order;
      unicastSrcIp = v.network.hosts.${name};
      unicastPeers = peersOn v.network;
      virtualIps = [ { addr = "${v.addr}/${v.network.prefix}"; } ];
      trackScripts = [ v.track ];
    }) vips;
  };

  # Whether this anchor holds the S3 VIP and passes the check. The cluster scrapes node-exporter,
  # and Garage's admin API listens on loopback only.
  systemd.services.anchor-s3-check = {
    description = "Export whether this anchor holds the S3 VIP and serves Garage";
    path = with pkgs; [
      coreutils
      gnugrep
      iproute2
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
      held=0
      if ip -4 -o addr show dev ${networks.lab.interface} | grep -qF ' ${lab.s3Vip}/'; then
        held=1
      fi
      serving=0
      if ${garageAnswers}; then
        serving=1
      fi
      metrics=$(mktemp ${metricsDir}/.anchor-s3-check.XXXXXX)
      trap 'rm -f "$metrics"' EXIT
      {
        printf '# HELP garage_s3_vip_held Whether this anchor holds the S3 VIP.\n'
        printf '# TYPE garage_s3_vip_held gauge\n'
        printf 'garage_s3_vip_held %s\n' "$held"
        printf '# HELP garage_s3_serving Whether Garage has a quorum and answers S3 on this anchor.\n'
        printf '# TYPE garage_s3_serving gauge\n'
        printf 'garage_s3_serving %s\n' "$serving"
      } > "$metrics"
      chmod 0644 "$metrics"
      mv "$metrics" ${metricsDir}/anchor-s3-check.prom
      trap - EXIT
    '';
  };

  systemd.timers.anchor-s3-check = {
    description = "Periodically export the S3 VIP and Garage state";
    wantedBy = [ "timers.target" ];
    timerConfig = {
      OnBootSec = "2m";
      OnUnitActiveSec = "1m";
      Unit = "anchor-s3-check.service";
    };
  };

  # VRRP (IP protocol 112) only from the other anchors. ./talos-boot.nix admits the boot VIP's VRRP
  # in its bootstrap chain.
  networking.firewall.extraCommands = lib.concatMapStrings (peer: ''
    iptables -A nixos-fw -i ${networks.lab.interface} -p 112 -s ${peer} -j nixos-fw-accept
  '') (peersOn networks.lab);

  assertions = [
    {
      assertion = lib.elem name anchors;
      message = "anchor-vips.nix may only be imported by an anchor: ${lib.concatStringsSep ", " anchors}";
    }
  ];
}
