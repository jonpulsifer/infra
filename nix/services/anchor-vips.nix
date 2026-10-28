# ns1 and ns2, the anchors' shared addresses for DNS and NTP. keepalived on every anchor runs
# unicast VRRP for both. Each VIP prefers its own order of anchors, and an anchor whose CoreDNS
# stops answering drops below every healthy one, so the VIP follows a working resolver.
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
  peers = map (anchor: lab.hosts.${anchor}) (lib.remove name anchors);
  prefix = lib.last (lib.splitString "/" lab.cidr);
  vips = {
    ns1 = {
      routerId = 53;
      order = [
        "capsule"
        "forge"
        "spore"
      ];
    };
    ns2 = {
      routerId = 54;
      order = [
        "forge"
        "spore"
        "capsule"
      ];
    };
  };
  # 150, 100 and 50 down the order. A failed check takes 120 off, below the lowest healthy anchor.
  priority = order: 150 - 50 * lib.lists.findFirstIndex (anchor: anchor == name) 2 order;
  # CoreDNS answers localhost from /etc/hosts through its hosts plugin, with no upstream involved.
  corednsAnswers = pkgs.writeShellScript "anchor-coredns-answers" ''
    [ "$(${pkgs.dnsutils}/bin/dig +short +time=1 +tries=1 @127.0.0.1 localhost A)" = 127.0.0.1 ]
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
      interface = "end0";
      state = "BACKUP";
      virtualRouterId = v.routerId;
      priority = priority v.order;
      unicastSrcIp = lab.hosts.${name};
      unicastPeers = peers;
      virtualIps = [ { addr = "${lab.ns.${vip}}/${prefix}"; } ];
      trackScripts = [ "coredns" ];
    }) vips;
  };

  # VRRP (IP protocol 112) only from the other anchors.
  networking.firewall.extraCommands = lib.concatMapStrings (peer: ''
    iptables -A nixos-fw -p 112 -s ${peer} -j nixos-fw-accept
  '') peers;

  assertions = [
    {
      assertion = lib.elem name anchors;
      message = "anchor-vips.nix may only be imported by an anchor: ${lib.concatStringsSep ", " anchors}";
    }
  ];
}
