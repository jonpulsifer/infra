# Boot-critical TFTP + static HTTP PXE serving, migrated from Alpine.
# dnsmasq (TFTP-only, port=0) + nginx setup. terraform/network/unifi/folly/k8s.tf
# points bare-metal k8s node netboot at this host's TFTP (boot/ipxe.efi) and
# the ipxe menu chains to per-target bzImage/initrd served over HTTP (TFTP is
# far too slow for ~900MB initrds).
#
# This module remains the sole owner of dnsmasq, TFTP, and the static nginx
# root used by x86 PXE. apps/spore/module.nix adds its API routes and an
# internal native-artifact location without taking ownership of this tree.
# The actual content under
# /var/lib/tftpboot (ipxe.efi, menu.ipxe, per-target netboot images) is
# build/backup artifacts, not something Nix generates -- restore it from
# backup or `nix build .#netboot` after this is deployed.
{ ... }:
{
  systemd.tmpfiles.rules = [
    "d /var/lib/tftpboot 0755 root root -"
  ];

  services.dnsmasq = {
    enable = true;
    resolveLocalQueries = false;
    settings = {
      port = 0;
      enable-tftp = true;
      tftp-root = "/var/lib/tftpboot";
      tftp-max = 100;
    };
  };

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

  # Metrics for the PXE HTTP endpoint: the stub_status page stays
  # localhost-only, the exporter republishes it on :9113 for Prometheus
  # (scraped via clusters/folly/monitoring/spore.yaml).
  services.nginx.statusPage = true;
  services.prometheus.exporters.nginx = {
    enable = true;
    openFirewall = true;
  };

  networking.firewall = {
    allowedTCPPorts = [ 80 ];
    allowedUDPPorts = [ 69 ]; # tftp
  };
}
