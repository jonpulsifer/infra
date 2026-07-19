# spore, reinstalled from Alpine to NixOS in place, keeping its identity
# (MAC/DNS octet in terraform/network/unifi/folly/clients.yaml, full IP in
# terraform/network/unifi/folly/lab.tf.json) so
# clusters/folly/storage/spore-pv.yaml, the nfs-provisioner HelmRelease, and
# terraform/network/unifi/folly/k8s.tf's PXE tftp_server/boot.server all keep
# working unchanged -- only the OS underneath changes.
#
# spore has no SD card: it boots directly off its single NVMe drive, which
# is what the sd-image gets flashed onto. That's also the only place to put
# NFS data, so this needs a THIRD partition carved out of the same MBR disk
# the sd-image module already partitions into firmware + root. rackpi5 is
# stateless and consumes none of this storage.
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
let
  # Lab-net host IPs come from the Lab SSOT, terraform/network/unifi/folly/lab.tf.json.
  lab =
    (builtins.fromJSON (builtins.readFile ../../terraform/network/unifi/folly/lab.tf.json)).locals.lab;
in
{
  imports = [
    ../hardware/pi5
    ../hardware/pi5/nvme-hat.nix
    ../services/common.nix
    ../services/nfs-server.nix
    ../services/pxe-netboot.nix
    ../system/spore.nix
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

  services.spore.managementCidrs = [
    "127.0.0.0/8"
    "::1/128"
    "100.64.0.0/10"
    "10.1.0.0/24" # fml / management LAN
    lab.cidr # 10.2.0.0/24 — lab LAN
    "10.3.0.0/26" # k8s node subnet
    "10.13.37.0/28" # future VLAN
  ];
  services.spore.managementAliases = [
    "spore.pirate-musical.ts.net"
    lab.hosts.spore # 10.2.0.11 — reachable by LAN IP
  ];

  # Desired boot state is built into an immutable catalog. MAC addresses are
  # derived from clients.yaml in the package closure, keeping UniFi's client
  # inventory as the single source of truth instead of transcribing it here.
  services.spore = {
    enable = true;
    catalog = {
      serverOrigin = "http://${lab.hosts.spore}/spore";
      allowUnknownHosts = true;
      defaultProfile = "default-menu";
      hostsSource = ../../terraform/network/unifi/folly/clients.yaml;
      hostsSourceGroup = "k8s";
      hostsSourceProfile = "k8s-node";
      profiles = {
        default-menu = {
          name = "Default Boot Menu";
          description = "Fallback menu for unassigned and newly observed hosts";
          content = ''
            #!ipxe
            dhcp
            set base-url {{base_url}}

            :start
            menu iPXE Boot Menu - {{hostname}} ({{mac}})
            item --gap -- -------------------------
            item k8s-node Boot the NixOS K8s node path
            item netbootxyz Open netboot.xyz
            item shell Open an iPXE shell
            item local Boot from local disk
            choose --default k8s-node --timeout 5000 target && goto ''${target}

            :k8s-node
            chain ''${base-url}/api/scripts/k8s-node/netboot.ipxe?mac={{mac}}

            :netbootxyz
            chain --replace https://boot.netboot.xyz/menu.ipxe

            :shell
            shell

            :local
            exit
          '';
        };
        k8s-node = {
          name = "K8s Node";
          description = "Direct chain to the Nix-owned static PXE menu";
          content = ''
            #!ipxe
            dhcp
            chain {{base_url}}/api/scripts/k8s-node/netboot.ipxe?mac={{mac}}
          '';
        };
      };
      scripts = {
        "k8s-node/netboot.ipxe" = {
          description = "Hand off to the independently served static PXE tree";
          content = ''
            #!ipxe
            echo Loading the NixOS PXE menu for {{hostname}} ({{mac}})...
            chain http://{{server_ip}}/menu.ipxe
          '';
        };
        "nuc/netboot.ipxe" = {
          description = "Open the upstream netboot.xyz management menu";
          content = ''
            #!ipxe
            echo Loading the management menu for {{hostname}} ({{mac}})...
            chain --replace https://boot.netboot.xyz/menu.ipxe
          '';
        };
      };
      nativeBootTargets.rackpi5 = {
        hostname = "rackpi5";
        protocol = "raspberry-pi-http";
      };
    };
  };

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
