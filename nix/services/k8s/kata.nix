{
  config,
  lib,
  pkgs,
  ...
}:
let
  # Both runtimes are the same shim binary. containerd resolves a runtime_type
  # of io.containerd.<name>.v2 to a containerd-shim-<name>-v2 on its PATH, and
  # kata-runtime ships containerd-shim-kata-clh-v2 as a symlink to the one
  # binary. The shim does NOT infer its hypervisor from that name — it reads
  # ConfigPath out of the containerd runtime options and otherwise falls back
  # to a compiled-in default that points at the QEMU config. Naming the config
  # here is what actually separates the two, so neither entry may drop it, and
  # the runtime name does not spell the config name: kata is configured by
  # configuration-qemu.toml.
  kataRuntime = name: hypervisor: {
    runtime_type = "io.containerd.${name}.v2";
    # A privileged container inside the VM must not be handed the host's
    # device nodes — that punches straight through the boundary kata exists
    # to draw.
    privileged_without_host_devices = true;
    options.ConfigPath =
      "${pkgs.kata-runtime}/share/defaults/kata-containers/configuration-${hypervisor}.toml";
  };
in
{
  config = lib.mkIf config.services.kubernetes.kubelet.enable {
    # Kata boots every sandbox as a microVM. QEMU reaches its guest agent over
    # a vhost-vsock device, and pod traffic rides virtio-net, so both drivers
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
    # configs it installs. Cloud Hypervisor arrives through the kata-runtime
    # overlay, which repairs the one path nixpkgs leaves dangling. There is no
    # /etc/kata-containers to manage either way.
    systemd.services.containerd.path = [ pkgs.kata-runtime ];
    virtualisation.containerd.settings = {
      plugins."io.containerd.grpc.v1.cri".containerd.runtimes = {
        # QEMU: the mature default, and the hypervisor kata exercises most.
        kata = kataRuntime "kata" "qemu";
        # Cloud Hypervisor: a much smaller VMM than QEMU on the same KVM, so a
        # narrower host attack surface and a faster sandbox start. It carries
        # less device support, so it is offered alongside QEMU rather than
        # replacing it.
        kata-clh = kataRuntime "kata-clh" "clh";
      };
    };
  };
}
