{ config, lib, pkgs, ... }:

{
  services.qbittorrent = {
    enable = true;
    dataDir = "/mnt/disks/qbittorrent";
  };
}
