# Redundant LAN time service shared by capsule and spore. Both hosts synchronise
# from authenticated Internet sources and poll one another. Chrony's orphan
# mode elects one local reference if every upstream is unavailable, keeping
# the lab internally consistent while honestly reporting low-quality stratum
# 10 time.
{ lib, name, ... }:
let
  lab = import ../lib/lab.nix;
  peer =
    if name == "capsule" then
      lab.hosts.spore
    else if name == "spore" then
      lab.hosts.capsule
    else
      throw "ntp-server.nix supports only capsule and spore, not ${name}";
in
{
  services.chrony = {
    enable = true;
    enableNTS = true;
    servers = [
      "time.nrc.ca"
      "time.chu.nrc.ca"
    ];
    extraConfig = ''
      # The two LAN servers poll one another so orphan mode can elect a leader
      # and preserve a common timebase during a total upstream outage.
      server ${peer} iburst
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
      assertion = lib.elem name [
        "capsule"
        "spore"
      ];
      message = "ntp-server.nix may only be imported by capsule or spore";
    }
  ];
}
