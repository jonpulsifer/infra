{ config,... }:
{
  imports = [
    ./modules/github-runner.nix
  ];

  services.tailscale = {
    extraUpFlags = [ "--advertise-routes=192.168.2.0/24" ];
    useRoutingFeatures = "both";
  };

  services.ddnsd.enable = true;
  virtualisation.docker.enable = true;
}
