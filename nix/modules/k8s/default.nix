{
  config,
  lib,
  pkgs,
  ...
}:
let
  cfg = config.services.k8s;
in
{
  options.services.k8s = {
    enable = lib.mkEnableOption "Kubernetes";
    network = lib.mkOption {
      type = lib.types.enum [
        "folly"
        "offsite"
      ];
      description = "K8s network configuration";
    };
    role = lib.mkOption {
      type = lib.types.enum [
        "control-plane"
        "worker"
      ];
      description = "K8s node role";
    };
  };
}
