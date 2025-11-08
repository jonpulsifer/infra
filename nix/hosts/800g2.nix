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
  boot.kernelModules = [ "kvm-intel" ];
  services.k8s = {
    enable = true;
    network = "folly";
  };
  networking.hostName = name;
}
