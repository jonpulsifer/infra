{ config, pkgs, .. }:
{
  imports = [
    ../profiles/rpi.nix
    ../services/kiosk.nix
  ];

  networking.wireless = {
    enable = true;
    networks.Goggly2.pskRaw = "c1e6a7dd93cd062b1b0e1f394b54f5a80ce63de04e9d9478f87312f8099df864";
  };
  
  services.tailscale = {
    extraUpFlags = [ "--advertise-routes=192.168.2.0/24" ];
    useRoutingFeatures = "both";
  };


  systemd.services.tailscale-transport-layer-offloads = {
    # https://tailscale.com/kb/1320/performance-best-practices#ethtool-configuration.
    description = "Linux optimizations for subnet routers and exit nodes";
    after = [ "network.target" ];
    serviceConfig = {
      Type = "oneshot";
      ExecStart = "${pkgs.ethtool}/sbin/ethtool -K wlan0 rx-udp-gro-forwarding on rx-gro-list off";
    };
    wantedBy = [ "default.target" ];
  };

  services.kiosk = {
    enable = true;
    container = true;
  };
}
