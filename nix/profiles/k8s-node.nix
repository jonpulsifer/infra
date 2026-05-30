{
  name,
  ...
}:
{
  imports = [
    ../hardware/x86
    ../disko
    ../services/common.nix
    ../services/k8s
  ];

  boot.initrd.availableKernelModules = [ "nvme" ];
  boot.kernelModules = [ "kvm-intel" ];

  services.k8s.enable = true;
  networking.hostName = name;

}
