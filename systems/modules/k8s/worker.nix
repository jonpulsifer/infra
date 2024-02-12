{ config, lib, pkgs, ... }:
{
  imports = [ ./common.nix ];
  services.kubernetes = {
    kubelet.kubeconfig.server = config.services.kubernetes.apiserverAddress;
    apiserverAddress = config.services.kubernetes.apiserverAddress;

  };
}
