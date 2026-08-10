# An x86 Kubernetes node in one of the two clusters.
#
# Cluster membership is read from the host's tailnet tags: a node tagged
# "folly" or "offsite" joins that cluster. The tag is the same one Tailscale
# advertises for ACL purposes, so there is one fact, not two to keep in sync.
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

  # The in-cluster node-exporter DaemonSet scrapes this drop box on every
  # node (clusters/folly/monitoring/kube-prometheus.yaml); a node without
  # the directory trips NodeTextFileCollectorScrapeError. Ownership is left
  # unmanaged ("-") so bosun's StateDirectory keeps the dir on riptide.
  systemd.tmpfiles.rules = [
    "d /var/lib/prometheus-node-exporter-text-files 0755 - - -"
  ];
}
