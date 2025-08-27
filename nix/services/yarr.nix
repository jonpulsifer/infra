{
  config,
  lib,
  pkgs,
  ...
}:

let
  downloadDir = "/mnt/disks/transmission";
  uiPort = 9091;
in
{
  networking.firewall.enable = lib.mkForce false;
  services = {
    mullvad-vpn.enable = true;
    transmission = {
      enable = true;
      package = pkgs.transmission_4;
      openPeerPorts = true;
      settings = {
        download-dir = downloadDir;
        incomplete-dir = "${downloadDir}/.incomplete";
        watch-dir = "${downloadDir}/.watch";

        peer-port = 51413;
        peer-limit-global = 10000;
        peer-limit-per-torrent = 1000;
        peer-limit-per-ip = 100;

        encryption = 2;
        blocklist-enabled = true;
        blocklist-url = "https://github.com/Naunter/BT_BlockLists/raw/master/bt_blocklists.gz";
        port-forwarding-enabled = false;
        anti-brute-force-enabled = true;
        anti-brute-force-threshold = 10;

        dht-enabled = false;
        pex-enabled = false;
        lpd-enabled = false;

        rpc-bind-address = "0.0.0.0";
        rpc-host-whitelist = "*.pirate-musical.ts.net";
        rpc-host-whitelist-enabled = true;
        rpc-port = uiPort;
        rpc-whitelist-enabled = true;
        rpc-whitelist = "127.0.0.1,192.168.*.*,10.*.*.*,100.*.*.*";
        rpc-authentication-required = false;
      };
    };

    # https://github.com/NixOS/nixpkgs/issues/360592
    sonarr.enable = true;

    bazarr.enable = true;
    radarr.enable = true;
    prowlarr.enable = true;
  };
  nixpkgs.config.permittedInsecurePackages = [
    "aspnetcore-runtime-6.0.36"
    "aspnetcore-runtime-wrapped-6.0.36"
    "dotnet-sdk-6.0.428"
    "dotnet-sdk-wrapped-6.0.428"
  ];
}
