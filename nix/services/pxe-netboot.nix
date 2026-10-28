# spore's nginx default server, `spore-pxe`: /var/lib/tftpboot and the signed native-boot files
# (./spore-native-boot.nix) over HTTP, open only to the Anchor network (forge's rackpi5 fallback) and the future
# network, never the Kubernetes network. ./talos-boot.nix, on every anchor, runs dnsmasq's TFTP and
# serves the Talos boot files on the bootstrap VLAN.
{ lib, ... }:
let
  lab = import ../lib/anchor.nix;
in
{
  services.nginx = {
    enable = true;
    virtualHosts."spore-pxe" = {
      default = true;
      root = "/var/lib/tftpboot";
      locations."/" = {
        extraConfig = ''
          autoindex on;
          add_header Last-Modified $date_gmt;
          add_header Cache-Control 'no-store, no-cache, must-revalidate, proxy-revalidate, max-age=0';
          if_modified_since off;
          expires off;
          etag off;
        '';
      };
    };
  };

  # stub_status stays on localhost; the exporter republishes it on :9113 for
  # clusters/folly/monitoring/spore.yaml.
  services.nginx.statusPage = true;
  services.prometheus.exporters.nginx = {
    enable = true;
    openFirewall = true;
  };

  networking.firewall.extraCommands =
    lib.concatMapStrings
      (cidr: ''
        iptables -A nixos-fw -p tcp -s ${cidr} --dport 80 -j nixos-fw-accept
      '')
      [
        lab.cidr
        lab.futureCidr
      ];
}
