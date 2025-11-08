{ config, inputs, name, ... }:
{
  imports = [
    ../hardware/pi4
    ../services/common.nix
    inputs.hosts.nixosModule
  ];

  networking = {
    hostName = name;
    wireless.enable = false;
  };

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
          cache {
            disable denial lolwtf.ca
          }
          forward . 127.0.0.1:1337 {
            next SERVFAIL
          }
          forward . tls://1.1.1.2 tls://1.0.0.2 {
            policy random
            tls_servername cloudflare-dns.com
            health_check 5s
          }
          errors
          prometheus 0.0.0.0:9253
      }

      .:1337 {
          hosts {
            ttl 604800
          }
          log . {
            class success
          }
      }
    '';
  };
}
