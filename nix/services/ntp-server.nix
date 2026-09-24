# LAN time service on capsule and spore. Each syncs from NTS sources and polls the other, and
# orphan mode keeps a common stratum 10 timebase if every upstream fails.
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
    # With enableNTS, chrony selects only sources that answer NTS-KE on tcp/4460. A server
    # without NTS is silently unselectable.
    servers = [
      "time.nrc.ca"
      "time.cloudflare.com"
      "nts.netnod.se"
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
