{ inputs, lib, ... }:
let
  # CoreDNS forwards over TLS; the host itself uses the local resolver first
  # and these same endpoints as recovery if CoreDNS is unavailable.
  upstreams = [
    "1.1.1.2"
    "1.0.0.2"
  ];
in
{
  imports = [ inputs.hosts.nixosModule ];

  networking.nameservers = [ "127.0.0.1" ] ++ upstreams;

  # CoreDNS owns port 53 on every interface. Keep resolved and Tailscale DNS
  # from competing for that listener or rewriting the host's resolver path.
  services.resolved.enable = lib.mkForce false;
  services.tailscale.extraSetFlags = [ "--accept-dns=false" ];

  networking.stevenBlackHosts = {
    enable = true;
    enableIPv6 = true;
    blockFakenews = true;
    blockGambling = true;
    blockPorn = true;
    blockSocial = true;
  };

  services.coredns = {
    enable = true;
    config = ''
      . {
        errors
        hosts {
          # The hosts plugin caps TTL at 65535 seconds. /etc/hosts is an
          # immutable Nix-store file, so polling it for changes only burns I/O.
          ttl 65535
          reload 0
          fallthrough
        }
        cache {
          disable denial lolwtf.ca
        }
        forward . ${lib.concatStringsSep " " (map (upstream: "tls://${upstream}") upstreams)} {
          policy random
          tls_servername cloudflare-dns.com
          health_check 5s
        }
        prometheus 0.0.0.0:9253
      }
    '';
  };

  networking.firewall = {
    allowedTCPPorts = [
      53
      9253
    ];
    allowedUDPPorts = [ 53 ];
  };
}
