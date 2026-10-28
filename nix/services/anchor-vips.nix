# The anchors' shared addresses. ns1 and ns2 carry DNS and NTP on Lab Net; boot carries the Talos
# boot files on the bootstrap VLAN (./talos-boot.nix). keepalived on every anchor runs unicast VRRP
# for each. Each VIP prefers its own order of anchors, and an anchor whose service stops answering
# drops below every healthy one, so the VIP follows a working server.
{
  lib,
  pkgs,
  name,
  ...
}:
let
  lab = import ../lib/lab.nix;
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
