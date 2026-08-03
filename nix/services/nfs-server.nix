# NFS server for the folly k8s cluster's shared storage. The backing mount,
# exports, and post-mount directory ownership are all Nix-owned. Hosts with a
# dedicated GPT data disk use the partlabel default; spore overrides it with
# the filesystem label created by its restart-safe first-boot partitioner.
{
  config,
  lib,
  pkgs,
  ...
}:
let
  networks = import ./k8s/networks.nix { inherit lib; };
  folly = networks.folly;
  lab = import ../lib/lab.nix;
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
    ];

    # tmpfiles can run before /nfs/data is mounted and create these paths on
    # root, where the data mount then hides them. Create them only after the
    # real filesystem is present, and make NFS depend on that post-mount setup.
    systemd.services.nfs-data-directories = {
      description = "Create NFS export directories on the mounted data filesystem";
      unitConfig.RequiresMountsFor = [ "/nfs/data" ];
      requiredBy = [
        "nfs-server.service"
        "nfs-mountd.service"
      ];
      before = [
        "nfs-server.service"
        "nfs-mountd.service"
      ];
      serviceConfig = {
        Type = "oneshot";
        RemainAfterExit = true;
      };
      path = [ pkgs.coreutils ];
      script = ''
        install -d -m 0777 -o nobody -g nobody \
          /nfs/data/k8s \
          /nfs/data/k8s-provisioned
      '';
    };

    services.nfs.server = {
      enable = true;
      # Fixed ports so the auxiliary RPC services can be pinned in the firewall.
      lockdPort = 4001;
      mountdPort = 4002;
      statdPort = 4000;
      # Cluster ranges come from cluster-topology; the client LAN comes from
      # the lab-topology ConfigMap shared with Flux and OpenTofu.
      exports = ''
        /nfs/data/                 ${lab.futureCidr}(rw,sync,nohide,no_subtree_check,insecure,all_squash,anonuid=1000,anongid=1000)
        /nfs/data/k8s/              ${folly.nodeCidr}(rw,sync,nohide,no_subtree_check,insecure,no_root_squash) ${folly.podCidr}(rw,sync,nohide,no_subtree_check,insecure,no_root_squash) ${folly.lbRange}(rw,sync,nohide,no_subtree_check,insecure,no_root_squash)
        /nfs/data/k8s-provisioned/  ${folly.nodeCidr}(rw,sync,nohide,no_subtree_check,insecure,no_root_squash) ${folly.podCidr}(rw,sync,nohide,no_subtree_check,insecure,no_root_squash) ${folly.lbRange}(rw,sync,nohide,no_subtree_check,insecure,no_root_squash)
      '';
    };

    # /nfs/data is nofail, so on boot without the NVMe attached it would
    # otherwise silently stay an empty directory on the SD card while nfsd
    # exports it anyway. nfs-data-directories.requiredBy creates dependency
    # symlinks for the upstream static NFS units, making a missing data mount a
    # hard failure instead of a silent wrong-export.

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
