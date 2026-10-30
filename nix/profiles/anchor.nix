# An anchor is one of the three Raspberry Pi 5s (capsule, spore and forge) that run the lab's
# shared network services: recursive DNS and NTP behind the ns1 and ns2 VIPs, and Garage behind the
# S3 VIP. spore alone serves the Talos boot files and fleetd on the bootstrap VLAN
# (../hosts/spore.nix).
{
  config,
  lib,
  ...
}:
let
  metricsDir = "/var/lib/prometheus-node-exporter-text-files";
in
{
  options.homelab.site = lib.mkOption {
    type = lib.types.str;
    default = "folly";
    description = ''
      The site this anchor serves. The boot plane's paths, metrics labels and committed
      per-site files (terraform/pki/certs, clusters/<site>/) follow it.
    '';
  };

  imports = [
    ../services/anchor-vips.nix
    ../services/coredns-sinkhole.nix
    ../services/devid-ca-yubikey.nix
    ../services/ntp-server.nix
  ];

  config = {
    # The anchors' check services write gauges here, for node-exporter's textfile collector.
    services.prometheus.exporters.node = {
      enabledCollectors = [ "textfile" ];
      extraFlags = [ "--collector.textfile.directory=${metricsDir}" ];
    };

    systemd.tmpfiles.rules = [
      "d ${metricsDir} 0755 root root -"
      # No service writes these any more, and node-exporter would export their last series forever.
      "r ${metricsDir}/talos-attest.prom"
      "r ${metricsDir}/talos-attest-check.prom"
      "r ${metricsDir}/fleet-controller.prom"
      "r ${metricsDir}/talos-enroll-check.prom"
    ]
    ++ lib.optionals (!(config.services.nginx.virtualHosts ? talos-boot)) [
      "r ${metricsDir}/talos-boot-check.prom"
      "r ${metricsDir}/talos-boot-mirror.prom"
    ];
  };
}
