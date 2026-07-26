{ lib, name, ... }:
let
  # Public upstreams for pihole, and this host's own fallback resolver. Shared
  # so the two can't drift apart.
  upstreams = [
    "1.1.1.2"
    "1.0.0.2"
  ];
in
{
  imports = [
    ../hardware/pi5
    ../hardware/pi5/nvme-hat.nix
    ../services/common.nix
    ../services/ntp-server.nix
  ];

  networking = {
    hostName = name;
    wireless.enable = lib.mkForce false;

    # Resolve through the local pihole, falling back to its own upstreams so a
    # pihole-FTL outage doesn't also cost this host name resolution (which is
    # what a `nixos-rebuild` needs to fetch a fix).
    nameservers = [ "127.0.0.1" ] ++ upstreams;
  };

  # Everywhere else, ../../nix/system/tailscale.nix leaves systemd-resolved
  # enabled and tailscaled parks the real upstream resolvers there, so
  # /etc/resolv.conf pointing at MagicDNS (100.100.100.100) still resolves.
  # This host force-disables resolved below -- pihole-FTL binds 0.0.0.0:53 and
  # would collide with resolved's stub listener -- which leaves the
  # coordination server supplying no resolvers and MagicDNS falling back to
  # "system default". That default is the resolv.conf tailscaled itself just
  # rewrote to 100.100.100.100, so every public lookup loops back into
  # tailscaled and SERVFAILs. Keep Tailscale out of DNS on this host; the
  # nameservers above are the whole story.
  services.tailscale.extraSetFlags = [ "--accept-dns=false" ];

  # Keep the labels already installed on the NVMe. The Pi 5 hardware module
  # normally derives these from `name`, but changing them during a hostname
  # migration would make the existing root and firmware filesystems disappear.
  sdImage = {
    rootVolumeLabel = lib.mkForce "NIXOS_DNS";
    firmwarePartitionName = lib.mkForce "FW_DNS";
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
        inherit upstreams;
        listeningMode = "ALL";
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
    hostName = "dns.lolwtf.ca";
    ports = [ 80 ];
  };

  services.resolved.enable = lib.mkForce false;

  services.prometheus.exporters.pihole = {
    enable = true;
    openFirewall = true;
    piholeHostname = "dns.lolwtf.ca";
  };
}
