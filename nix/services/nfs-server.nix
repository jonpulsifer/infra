# NFS server for the folly cluster's shared storage. dataDevice defaults to a GPT partlabel;
# spore overrides it with the filesystem label its first-boot partitioner writes.
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

    # Create the export dirs after /nfs/data mounts, or tmpfiles creates them on root, hidden by the mount. The
    # mount is nofail, so requiredBy makes a missing data disk fail NFS instead of exporting an empty root dir.
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
      # Numeric ids: the nobody group exists only in nss-systemd, which does not answer while a
      # switch restarts systemd.
      script = ''
        install -d -m 0777 -o 65534 -g 65534 \
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
      exports = ''
        /nfs/data/                 ${lab.futureCidr}(rw,sync,nohide,no_subtree_check,insecure,all_squash,anonuid=1000,anongid=1000)
        /nfs/data/k8s/              ${folly.nodeCidr}(rw,sync,nohide,no_subtree_check,insecure,no_root_squash) ${folly.podCidr}(rw,sync,nohide,no_subtree_check,insecure,no_root_squash) ${folly.lbRange}(rw,sync,nohide,no_subtree_check,insecure,no_root_squash)
        /nfs/data/k8s-provisioned/  ${folly.nodeCidr}(rw,sync,nohide,no_subtree_check,insecure,no_root_squash) ${folly.podCidr}(rw,sync,nohide,no_subtree_check,insecure,no_root_squash) ${folly.lbRange}(rw,sync,nohide,no_subtree_check,insecure,no_root_squash)
      '';
    };

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
