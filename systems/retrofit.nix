{ config, pkgs, name, ... }:
{
  imports = [
    ../nix/modules/yarr.nix
    ../nix/modules/jellyfin.nix
  ];
  networking.hostName = name;
  networking.wireless = {
    enable = true;
    networks = {
      Goggly = {
        pskRaw = "c1e6a7dd93cd062b1b0e1f394b54f5a80ce63de04e9d9478f87312f8099df864";
      };
      # Goggly2 = {
      #   pskRaw = "fd6e6e6bbb22865a53302494040e6e3799a2f097a8321152e264c568bc16b3d5";
      # };
    };
  };

  services.ddnsd.enable = true;
  services.tailscale = {
    extraUpFlags = [ "--advertise-routes=192.168.2.0/24" ];
    useRoutingFeatures = "both";
  };

  systemd.services.tailscale-transport-layer-offloads = {
    # https://tailscale.com/kb/1320/performance-best-practices#ethtool-configuration.
    description = "Linux optimizations for subnet routers and exit nodes";
    after = ["network.target"];
    serviceConfig = {
      Type = "oneshot";
      ExecStart = "${pkgs.ethtool}/sbin/ethtool -K eno1 rx-udp-gro-forwarding on rx-gro-list off";
    };
    wantedBy = ["default.target"];
  };
}
