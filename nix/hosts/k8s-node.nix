{
  config,
  name,
  ...
}:
{
  imports = [
    ../hardware/x86
    ../services/common.nix
    ../services/k8s
  ];
  boot.initrd.availableKernelModules = [ "nvme" ];
  boot.kernelModules = [ "kvm-intel" ];
  services.k8s = {
    enable = true;
  };
  networking.hostName = name;

  systemd.services.tailscale-transport-layer-offloads = {
    # https://tailscale.com/kb/1320/performance-best-practices#ethtool-configuration.
    enable = config.services.tailscale.enable;
    description = "Linux optimizations for subnet routers and exit nodes";
    after = [ "network.target" ];
    serviceConfig = {
      Type = "oneshot";
      ExecStart = "${pkgs.ethtool}/sbin/ethtool -K eno1 rx-udp-gro-forwarding on rx-gro-list off";
    };
    wantedBy = [ "default.target" ];
  };
}
