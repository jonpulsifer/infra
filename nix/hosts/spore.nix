# spore, reinstalled from Alpine to NixOS in place, keeping its identity
# (MAC/IP/DNS in terraform/network/unifi/folly/clients.yaml) so
# clusters/folly/storage/spore-pv.yaml, the nfs-provisioner HelmRelease, and
# terraform/network/unifi/folly/k8s.tf's PXE tftp_server/boot.server all keep
# working unchanged -- only the OS underneath changes.
#
# spore has no SD card: it boots directly off its single NVMe drive, which
# is what the sd-image gets flashed onto. That's also the only place to put
# NFS data, so unlike rackpi5 (a second, dedicated GPT disk with a
# partlabel) this needs a THIRD partition carved out of the same MBR disk
# the sd-image module already partitions into firmware + root.
#
# The sd-image module's default `expandOnBoot` would grow root to consume
# the *entire* disk on first boot -- exactly the OS/data commingling this
# reinstall is meant to fix. So that's disabled here, replaced with a
# first-boot service that grows root to a fixed cap and gives the rest of
# the disk to a labeled ext4 partition for /nfs/data.
{
  config,
  lib,
  name,
  pkgs,
  ...
}:
{
  imports = [
    ../hardware/pi5
    ../hardware/pi5/nvme-hat.nix
    ../services/common.nix
    ../services/nfs-server.nix
    ../services/pxe-netboot.nix
  ];

  networking = {
    hostName = name;
    wireless.enable = lib.mkForce false;
  };

  # Alpine already ran this HAT's NVMe stable at Gen 3
  # (dtparam=pciex1_gen=3 in spore's old /boot/config.txt); carry that over
  # instead of nvme-hat.nix's conservative Gen 2 default.
  hardware.raspberry-pi.config.pi5.base-dt-params.pciex1_gen = {
    enable = true;
    value = 3;
  };

  homelab.nfsServer.dataDevice = "/dev/disk/by-label/nfs-data";

  # rackpi5 netboots from this host (see nix/hosts/rackpi5.nix): its / is the
  # NFS export below and its /boot/firmware is a directory inside the TFTP
  # root, exported rw so nixos-rebuilds on rackpi5 drop kernels straight into
  # the netboot tree dnsmasq already serves. no_root_squash because rackpi5's
  # root writes both as uid 0.
  systemd.tmpfiles.rules = [
    "d /nfs/data/rackpi5 0755 root root -"
    "d /var/lib/tftpboot/rackpi5 0755 root root -"
  ];
  services.nfs.server.exports = ''
    /nfs/data/rackpi5           10.2.0.12(rw,sync,no_subtree_check,insecure,no_root_squash)
    /var/lib/tftpboot/rackpi5   10.2.0.12(rw,sync,no_subtree_check,insecure,no_root_squash)
  '';
  # No file leases means nfsd grants no delegations. Nix hard-links files
  # inside rackpi5's NFS root, and a LINK against a file whose write
  # delegation the *same* client holds deadlocks in the server's recall
  # (observed: nix-env stuck in nfs4_proc_link indefinitely while populating
  # the netboot root). Delegations are a read-caching nicety; the k8s NFS
  # workloads don't miss them.
  boot.kernel.sysctl."fs.leases-enable" = 0;

  sdImage.expandOnBoot = false;

  systemd.services.grow-root-and-partition-storage = {
    description = "Grow root to a fixed cap and give the rest of the disk to /nfs/data";
    unitConfig = {
      DefaultDependencies = false;
      ConditionPathExists = config.sdImage.nixPathRegistrationFile;
    };
    wantedBy = [ "sysinit.target" ];
    before = [
      "sysinit.target"
      "shutdown.target"
      "register-nix-paths.service"
    ];
    after = [ "local-fs.target" ];
    conflicts = [ "shutdown.target" ];
    restartIfChanged = false;
    serviceConfig = {
      Type = "oneshot";
      RemainAfterExit = true;
    };
    path = with pkgs; [
      util-linux
      parted
      e2fsprogs
    ];
    script = ''
      set -euo pipefail

      # Idempotent: only the very first boot after flashing has no
      # nfs-data label yet.
      if blkid -L nfs-data >/dev/null 2>&1; then
        echo "nfs-data partition already exists, nothing to do"
        exit 0
      fi

      rootPart=$(findmnt -n -o SOURCE /)
      diskDev=$(lsblk -rnpo PKNAME "$rootPart")
      partNum=$(lsblk -rno PARTN "$rootPart")

      echo "root=$rootPart disk=$diskDev partNum=$partNum"

      # Grow root to a fixed cap -- NOT "+", which would claim the whole
      # disk the way the stock expand-root-partition service does.
      echo ",32G," | sfdisk -N"$partNum" --no-reread "$diskDev"
      partprobe "$diskDev"
      resize2fs "$rootPart"

      # Give everything after that to a new partition for /nfs/data.
      # NOT "echo ,+,L | sfdisk --append" -- with an unspecified start,
      # sfdisk fills the first free gap it finds in disk order, which on
      # this layout is a few reserved sectors *before* partition 1, not
      # the real free space after root. Compute the real start explicitly
      # from partition 2's own current geometry instead.
      rootStart=$(cat "/sys/class/block/$(basename "$rootPart")/start")
      rootSize=$(cat "/sys/class/block/$(basename "$rootPart")/size")
      dataStart=$(( rootStart + rootSize ))
      echo "start=$dataStart,type=L" | sfdisk --append --no-reread "$diskDev"
      partprobe "$diskDev"

      dataPart=$(lsblk -rnpo NAME "$diskDev" | tail -n1)
      echo "data partition: $dataPart"
      mkfs.ext4 -F -L nfs-data "$dataPart"

      mkdir -p /nfs/data
      mount -L nfs-data /nfs/data
    '';
  };
}
