{
  config,
  lib,
  pkgs,
  ...
}:
let
  # The shim takes its hypervisor from ConfigPath, not the runtime name, and falls back to QEMU.
  # The entry may not drop ConfigPath.
  kataRuntime = name: hypervisor: {
    runtime_type = "io.containerd.${name}.v2";
    # A privileged container in the VM must not get the host's device nodes; that breaks the VM boundary.
    privileged_without_host_devices = true;
    options.ConfigPath =
      "${pkgs.kata-runtime}/share/defaults/kata-containers/configuration-${hypervisor}.toml";
  };
in
{
  config = lib.mkIf config.services.kubernetes.kubelet.enable {
    # The guest agent talks over vhost-vsock and pod traffic uses virtio-net, so both must load before
    # containerd starts a sandbox. kvm-intel comes from the k8s-node profile.
    boot.kernelModules = [
      "vhost_vsock"
      "vhost_net"
    ];

    # The shim's configs name the guest kernel, rootfs, QEMU and virtiofsd as store paths; the
    # kata-runtime overlay supplies Cloud Hypervisor.
    systemd.services.containerd.path = [ pkgs.kata-runtime ];
    virtualisation.containerd.settings = {
      plugins."io.containerd.grpc.v1.cri".containerd.runtimes = {
        # Cloud Hypervisor: smaller attack surface and faster start, but less device support than QEMU.
        # The kata-clh RuntimeClass points at this handler.
        kata = kataRuntime "kata" "clh";
        # containerd resolves a running sandbox's stored handler when it creates a container, so
        # pods started before the rename need this entry to restart a container. Remove it once no
        # pod created under the old handler remains.
        kata-clh = kataRuntime "kata-clh" "clh";
      };
    };
  };
}
