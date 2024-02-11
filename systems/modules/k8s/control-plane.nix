{ config, lib, pkgs, ... }:

{
  imports = [ ./common.nix ];
  services.prometheus.exporters.node.enable = lib.mkForce false;
  services.kubernetes = {
    apiserver = {
      enable = true;
      allowPrivileged = true;
      extraSANs = [ "nuc" "nuc.lolwtf.ca" "nuc.fml.pulsifer.ca" "nuc.pirate-musical.ts.net" "10.3.0.10" ];
    };
    kubelet.enable = true;
    controllerManager.enable = true;
    scheduler.enable = true;
    addonManager.enable = true;
    proxy.enable = false;
    easyCerts = true;
    pki.enabled = true;
  };
  services.etcd.enable = true;
};
