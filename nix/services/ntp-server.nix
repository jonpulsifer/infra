# LAN time service on the anchors (capsule, spore and forge). Each syncs from NTS sources and polls
# the other anchors, and orphan mode keeps a common stratum 10 timebase if every upstream fails.
{ lib, name, ... }:
let
  lab = import ../lib/anchor.nix;
  anchors = [
    "capsule"
    "spore"
    "forge"
  ];
  peers = map (peer: lab.hosts.${peer}) (lib.remove name anchors);
in
{
  services.chrony = {
    enable = true;
    enableNTS = true;
    # With enableNTS, chrony selects only sources that answer NTS-KE on tcp/4460. A server
    # without NTS is silently unselectable.
    servers = [
      "time.nrc.ca"
      "time.cloudflare.com"
      "nts.netnod.se"
    ];
    extraConfig = ''
      # The anchors poll one another so orphan mode can elect a leader
      # and preserve a common timebase during a total upstream outage.
      ${lib.concatMapStringsSep "\n      " (peer: "server ${peer} iburst") peers}
      local stratum 10 orphan

      # Serve routed homelab IPv4 networks, but never become a public NTP
      # endpoint. The firewall separately limits ingress to UDP/123.
      allow 10.0.0.0/8
      ratelimit interval 1 burst 8
    '';
  };

  networking.firewall.allowedUDPPorts = [ 123 ];

  assertions = [
    {
      assertion = lib.elem name anchors;
      message = "ntp-server.nix may only be imported by an anchor: ${lib.concatStringsSep ", " anchors}";
    }
  ];
}
