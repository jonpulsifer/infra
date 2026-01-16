{
  config,
  lib,
  pkgs,
  ...
}:
{
  config = lib.mkIf config.services.kubernetes.kubelet.enable {
    systemd.services.containerd.path = [ pkgs.gvisor ];
    virtualisation.containerd.settings = {
      plugins."io.containerd.grpc.v1.cri" = {
        sandbox_image = "registry.k8s.io/pause:3.10";
        containerd.runtimes.runsc = {
          runtime_type = "io.containerd.runsc.v1";
        };
      };
    };
  };
}
