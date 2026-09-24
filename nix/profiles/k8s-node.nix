# An x86 Kubernetes node. Its "folly" or "offsite" Tailscale tag selects the cluster it joins.
{
  lib,
  pkgs,
  tags,
  ...
}:
let
  clusters = [
    "folly"
    "offsite"
  ];
  network =
    lib.findFirst (tag: lib.elem tag clusters)
      (throw "a k8s node must advertise its cluster as a tag: tags = [ \"folly\" ] or [ \"offsite\" ]")
      tags;
in
{
  imports = [
    ../hardware/x86
    ../disko
    ../services/k8s
  ];

  boot.initrd.availableKernelModules = [ "nvme" ];
  boot.initrd.kernelModules = [ "nfs" ];
  boot.initrd.supportedFilesystems = [ "nfs" ];
  boot.supportedFilesystems = lib.mkOverride 40 [
    "ext4"
    "vfat"
    "nfs"
  ];
  boot.kernelModules = [ "kvm-intel" ];

  environment.systemPackages = with pkgs; [
    nfs-utils
  ];

  services.k8s = {
    enable = true;
    inherit network;
  };

  # The node-exporter DaemonSet reads this textfile directory on every node; without it,
  # NodeTextFileCollectorScrapeError fires.
  systemd.tmpfiles.rules = [
    "d /var/lib/prometheus-node-exporter-text-files 0755 - - -"
  ];
}
