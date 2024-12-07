{ config, lib, pkgs, ... }:

let
  downloadDir = "/mnt/disks/transmission";
  uiPort = 9091;
in
{
  services = {
    transmission = {
      enable = true;
      package = pkgs.transmission_4;
      settings = {
        download-dir = downloadDir;
        incomplete-dir = "${downloadDir}/.incomplete";
        watch-dir = "${downloadDir}/.watch";

        encryption = 1;
        blocklist-enabled = true;
        blocklist-url = "https://github.com/Naunter/BT_BlockLists/raw/master/bt_blocklists.gz";
        port-forwarding-enabled = false;
        anti-brute-force-enabled = true;
        anti-brute-force-threshold = 10;

        rpc-bind-address = "0.0.0.0";
        rpc-port = uiPort;
        rpc-whitelist-enabled = true;
        rpc-whitelist = "127.0.0.1,192.168.*,10.*,100.64.*";
        rpc-authentication-required = false;
      };
    };

    sonarr.enable = true;
    bazarr.enable = true;
    radarr.enable = true;
    prowlarr.enable = true;
  };
}
