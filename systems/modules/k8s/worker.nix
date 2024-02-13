{ config, lib, pkgs, ... }:
{
  imports = [ ./common.nix ];
  services.kubernetes = {
    kubelet = {
      kubeconfig.server = config.services.kubernetes.apiserverAddress;
      taints = lib.mkForce { }; # we want to schedule workloads on the workers
    };
  };
}
