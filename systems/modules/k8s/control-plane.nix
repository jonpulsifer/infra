{ config, lib, pkgs, ... }:

{
  imports = [ ./common.nix ];
  services.etcd.enable = true;
  services.kubernetes = {
    apiserver = {
      enable = true;
      allowPrivileged = true;
      extraSANs = [ "nuc" "nuc.lolwtf.ca" "nuc.fml.pulsifer.ca" "nuc.pirate-musical.ts.net" "10.3.0.10" ];
      serviceClusterIpRange = "10.10.0.0/16";
    };
    controllerManager.enable = true;
    scheduler.enable = true;
    addonManager.enable = true;
    proxy.enable = false;
  };
}
