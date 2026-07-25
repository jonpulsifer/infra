{ inputs, ... }:
{
  imports = [ inputs.hosts.nixosModule ];

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
          ttl 604800
          fallthrough
        }
        cache {
          disable denial lolwtf.ca
        }
        forward . tls://1.1.1.2 tls://1.0.0.2 {
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
