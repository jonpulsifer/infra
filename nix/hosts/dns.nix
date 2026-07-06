{ lib, name, ... }:
{
  imports = [
    ../hardware/pi5
    ../hardware/pi5/nvme-hat.nix
    ../services/common.nix
  ];

  networking = {
    hostName = name;
    wireless.enable = lib.mkForce false;
  };

  services.pihole-ftl = {
    enable = true;
    openFirewallDNS = true;
    openFirewallWebserver = true;
    lists = [
      {
        url = "https://raw.githubusercontent.com/StevenBlack/hosts/master/hosts";
        description = "Steven Black's unified adlist";
      }
    ];
    settings = {
      dns = {
        upstreams = [
          "1.1.1.2"
          "1.0.0.2"
        ];
        # Every query otherwise gets a line appended to pihole.log; skip that
        # write stream entirely since Grafana (via the exporter below) is the
        # source of truth for stats, not the on-box query log.
        queryLogging = false;
      };
      database = {
        # FTL flushes its in-memory query buffer to gravity.db every
        # DBinterval (default 60s) -- that's a sqlite write every minute,
        # continuously, which is exactly the kind of wear an SD/SSD-hosted
        # DNS box shouldn't be doing. Flush hourly instead and keep almost no
        # local history, since long-term stats live in Prometheus.
        DBinterval = 3600;
        maxDBdays = 1;
      };
    };
  };

  services.pihole-web = {
    enable = true;
    ports = [ 80 ];
  };

  services.resolved.enable = lib.mkForce false;

  services.prometheus.exporters.pihole = {
    enable = true;
    openFirewall = true;
    piholeHostname = "127.0.0.1";
  };
}
