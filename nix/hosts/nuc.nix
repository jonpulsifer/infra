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
    network = "folly";
    role = "control-plane";
  };
  networking.hostName = name;
}
