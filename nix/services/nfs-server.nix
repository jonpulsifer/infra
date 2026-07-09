# NFS server for the folly k8s cluster's shared storage. Currently only
# spore (nix/hosts/spore.nix) uses this -- exports mirror what it served as
# Alpine 1:1 so clusters/folly/storage/spore-pv.yaml and the nfs-provisioner
# HelmRelease didn't need to change, only the OS underneath.
#
# The default backing disk is a dedicated GPT disk referenced by partlabel
# (e.g. a second drive with no OS on it). `nofail` keeps boot from blocking
# on its absence. Bring it up once by hand:
#   parted /dev/nvme0n1 -- mklabel gpt mkpart nfs-data ext4 0% 100%
#   mkfs.ext4 -L nfs-data /dev/disk/by-partlabel/nfs-data
#
# Hosts that share a single MBR-partitioned disk between OS and data (e.g.
# spore's sd-image-flashed NVMe, which has no partlabel support) override
# `homelab.nfsServer.dataDevice` to a by-label path instead.
{ config, lib, ... }:
let
  # folly cluster CIDRs come from the network SSOT (see nix/services/k8s/networks.nix).
  folly = (builtins.fromJSON (builtins.readFile ../../clusters/folly/config/cluster-topology.json)).data;
in
{
  options.homelab.nfsServer.dataDevice = lib.mkOption {
    type = lib.types.str;
    default = "/dev/disk/by-partlabel/nfs-data";
    description = "Block device backing the /nfs/data export.";
  };

  config = {
    fileSystems."/nfs/data" = {
      device = config.homelab.nfsServer.dataDevice;
      fsType = "ext4";
      options = [
        "nofail"
        "relatime"
      ];
    };

    systemd.tmpfiles.rules = [
      "d /nfs/data 0755 root root -"
      "d /nfs/data/k8s 0777 nobody nobody -"
      "d /nfs/data/k8s-provisioned 0777 nobody nobody -"
    ];

    services.nfs.server = {
      enable = true;
      # Fixed ports so the auxiliary RPC services can be pinned in the firewall.
      lockdPort = 4001;
      mountdPort = 4002;
      statdPort = 4000;
      # K8S_NODE_CIDR is the single Kubernetes network (VLAN 8, 10.3.0.0/26);
      # CILIUM_POD_CIDR covers the pods. 10.13.37.0/28 is the "future" network
      # (terraform/network/unifi/folly/extra-networks.tf).
      exports = ''
        /nfs/data/                 10.13.37.0/28(rw,sync,nohide,no_subtree_check,insecure,all_squash,anonuid=1000,anongid=1000)
        /nfs/data/k8s/              ${folly.K8S_NODE_CIDR}(rw,sync,nohide,no_subtree_check,insecure,no_root_squash) ${folly.CILIUM_POD_CIDR}(rw,sync,nohide,no_subtree_check,insecure,no_root_squash)
        /nfs/data/k8s-provisioned/  ${folly.K8S_NODE_CIDR}(rw,sync,nohide,no_subtree_check,insecure,no_root_squash) ${folly.CILIUM_POD_CIDR}(rw,sync,nohide,no_subtree_check,insecure,no_root_squash)
      '';
    };

    # /nfs/data is nofail, so on boot without the NVMe attached it would
    # otherwise silently stay an empty directory on the SD card while nfsd
    # exports it anyway. Require the real mount so a missing disk is a hard
    # failure to start, not a silent wrong-export.
    systemd.services.nfs-server.unitConfig.RequiresMountsFor = [ "/nfs/data" ];
    systemd.services.nfs-mountd.unitConfig.RequiresMountsFor = [ "/nfs/data" ];

    networking.firewall = {
      allowedTCPPorts = [
        111 # rpcbind
        2049 # nfsd
        4000 # rpc.statd
        4001 # lockd/nlockmgr
        4002 # rpc.mountd
      ];
      allowedUDPPorts = [
        111
        2049
        4000
        4001
        4002
      ];
    };
  };
}
