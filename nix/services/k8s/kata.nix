{
  config,
  lib,
  pkgs,
  ...
}:
{
  config = lib.mkIf config.services.kubernetes.kubelet.enable {
    # Kata boots every sandbox as a QEMU microVM. The guest agent talks to the
    # shim over vsock and pod traffic rides virtio-net, so both vhost drivers
    # have to be loaded before containerd starts a sandbox. The KVM driver
    # itself comes from the k8s-node profile (boot.kernelModules = kvm-intel);
    # every node in both clusters is a bare-metal Intel box, so no node carries
    # a runtime it cannot use.
    boot.kernelModules = [
      "vhost_vsock"
      "vhost_net"
    ];

    # pkgs.kata-runtime carries the shim, and through it the guest kernel and
    # rootfs image, QEMU and virtiofsd — all as store paths baked into the
    # shim's compiled-in defaults. There is no /etc/kata-containers to manage:
    # putting the package on containerd's PATH is the whole wiring.
    systemd.services.containerd.path = [ pkgs.kata-runtime ];
    virtualisation.containerd.settings = {
      plugins."io.containerd.grpc.v1.cri" = {
        containerd.runtimes.kata = {
          runtime_type = "io.containerd.kata.v2";
          # A privileged container inside the VM must not be handed the host's
          # device nodes — that punches straight through the boundary kata
          # exists to draw.
          privileged_without_host_devices = true;
        };
      };
    };
  };
}
