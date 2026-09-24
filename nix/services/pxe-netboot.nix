# x86 PXE: dnsmasq serves TFTP only (port=0), and terraform/network/unifi/folly/k8s.tf points netboot at
# boot/ipxe.efi. iPXE fetches kernels and initrds over HTTP, since TFTP is too slow for them.
# Nix does not generate /var/lib/tftpboot; restore it from backup or `nix build .#netboot`.
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
      # TFTP data leaves UDP/69 on a server-chosen port; bound it so the firewall admits it
      # without a conntrack helper.
      tftp-port-range = "30000,30099";
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

  # stub_status stays on localhost; the exporter republishes it on :9113 for
  # clusters/folly/monitoring/spore.yaml.
  services.nginx.statusPage = true;
  services.prometheus.exporters.nginx = {
    enable = true;
    openFirewall = true;
  };

  networking.firewall = {
    allowedTCPPorts = [ 80 ];
    allowedUDPPorts = [ 69 ]; # TFTP request port
    allowedUDPPortRanges = [
      {
        from = 30000;
        to = 30099;
      }
    ];
  };
}
