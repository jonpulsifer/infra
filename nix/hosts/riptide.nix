{
  config,
  name,
  ...
}:
{
  imports = [
    ../hardware/x86
    ../profiles/server.nix
    ../services/k8s
  ];
  boot.initrd.availableKernelModules = [ "nvme" ];
  boot.kernelModules = [ "kvm-intel" ];
  services.k8s = {
    enable = true;
    network = "folly";
  };
  networking.hostName = name;
}
