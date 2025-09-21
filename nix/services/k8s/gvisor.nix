{ config, lib, pkgs, ... }:
{
  config = lib.mkIf config.services.kubernetes.kubelet.enable {  
    environment.systemPackages = [ pkgs.gvisor ];
    systemd.services.kubelet.path = [ pkgs.gvisor ];
    virtualisation.containerd.settings = {
      plugins."io.containerd.grpc.v1.cri" = {
        containerd.runtimes.runsc = {
          runtime_type = "io.containerd.runsc.v1";
        };
      };
    };
  };
}