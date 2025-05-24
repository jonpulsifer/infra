{
  config,
  lib,
  ...
}:
{
  nixpkgs.overlays = [ (import ../../overlays/k8s.nix) ];
  services.kubernetes = {
    kubelet = {
      enable = true;
      kubeconfig.server = config.services.kubernetes.apiserverAddress;
      taints = lib.mkForce { }; # we want to schedule workloads on the workers
    };
  };
}
