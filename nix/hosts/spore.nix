# spore is an NVMe-rooted Pi 5 serving NFS, PXE, native-boot artifacts, DNS,
# and NTP. Its network identity comes from clusters/folly/config/lab-topology.json;
# clients.yaml retains the matching DHCP reservation.
#
# The single NVMe carries firmware + a capped root partition + NFS data. The
# sd-image module's default expandOnBoot would grow root across the whole disk,
# so the first-boot service below grows root to a fixed cap and gives the disk
# tail to a labeled ext4 partition mounted at /nfs/data.
{
  config,
  pkgs,
  ...
}:
{
  imports = [
    ../profiles/pi5-nvme.nix
    ../services/coredns-sinkhole.nix
    ../services/nfs-server.nix
    ../services/ntp-server.nix
    ../services/pxe-netboot.nix
    ../services/spore-native-boot.nix
  ];

  # Alpine ran this HAT's NVMe at Gen 3; retain that operating mode instead of
  # nvme-hat.nix's conservative Gen 2 default.
  hardware.raspberry-pi.config.pi5.base-dt-params.pciex1_gen = {
    enable = true;
    value = 3;
  };

  homelab.nfsServer.dataDevice = "/dev/disk/by-label/nfs-data";

  # Root is capped at 32G and every daily auto-upgrade generation drags a
  # fresh rackpi5 native-boot image along (~1G delta), so the fleet's
  # weekly/30d GC keeps a month of images and fills the disk.
  nix.gc = {
    dates = "daily";
    options = "--delete-older-than 7d";
  };

  # Signed native-boot publishing for rackpi5. The cross-host target is wired
  # in nix/lib/registry.nix, where rackpi5's piBootImg derivation is in scope.
  services.spore.enable = true;

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
      "nfs-data-directories.service"
    ];
    after = [ "local-fs.target" ];
    conflicts = [ "shutdown.target" ];
    restartIfChanged = false;
    serviceConfig = {
      Type = "oneshot";
      RemainAfterExit = true;
    };
    path = with pkgs; [
      coreutils
      util-linux
      parted
      e2fsprogs
      gnugrep
    ];
    script = ''
      set -euo pipefail

      rootPart=$(findmnt -n -o SOURCE /)
      diskDev=$(lsblk -rnpo PKNAME "$rootPart")
      rootPartNum=$(lsblk -rno PARTN "$rootPart")
      dataPartNum=$((rootPartNum + 1))
      dataPart=""

      find_data_partition() {
        local candidate candidatePartNum
        dataPart=""
        while read -r candidate candidatePartNum; do
          if [ "''${candidatePartNum:-}" = "$dataPartNum" ]; then
            dataPart="$candidate"
            break
          fi
        done < <(lsblk -rnpo NAME,PARTN "$diskDev")
        [ -n "$dataPart" ]
      }

      echo "root=$rootPart disk=$diskDev rootPartNum=$rootPartNum dataPartNum=$dataPartNum"

      if find_data_partition; then
        # An interrupted first boot may leave partition 3 present before it has
        # a filesystem or label. Reuse only the partition immediately after
        # root; never append a second data partition over existing state.
        rootStart=$(cat "/sys/class/block/$(basename "$rootPart")/start")
        rootSize=$(cat "/sys/class/block/$(basename "$rootPart")/size")
        expectedDataStart=$((rootStart + rootSize))
        actualDataStart=$(cat "/sys/class/block/$(basename "$dataPart")/start")
        if [ "$actualDataStart" -ne "$expectedDataStart" ]; then
          echo "$dataPart starts at $actualDataStart, expected $expectedDataStart after root" >&2
          exit 1
        fi
      else
        # Grow root to a fixed cap -- NOT "+", which would claim the whole
        # disk the way the stock expand-root-partition service does.
        echo ",32G," | sfdisk -N"$rootPartNum" --no-reread "$diskDev"
        partprobe "$diskDev"

        # Append after root's real geometry. An unspecified start lets sfdisk
        # choose an earlier reserved gap on this image layout.
        rootStart=$(cat "/sys/class/block/$(basename "$rootPart")/start")
        rootSize=$(cat "/sys/class/block/$(basename "$rootPart")/size")
        dataStart=$((rootStart + rootSize))
        echo "start=$dataStart,type=L" | sfdisk --append --no-reread "$diskDev"
        partprobe "$diskDev"
        find_data_partition || {
          echo "partition $dataPartNum did not appear on $diskDev" >&2
          exit 1
        }
      fi

      # Safe both after a fresh partition-table grow and after resuming an
      # interrupted first boot where partition 3 already exists.
      resize2fs "$rootPart"

      echo "data partition: $dataPart"
      fsType=$(blkid -o value -s TYPE "$dataPart" 2>/dev/null || true)
      fsLabel=$(blkid -o value -s LABEL "$dataPart" 2>/dev/null || true)
      case "$fsType" in
        "")
          if wipefs --noheadings --output TYPE "$dataPart" | grep -q '[^[:space:]]'; then
            echo "$dataPart has an unrecognized filesystem signature; refusing to format" >&2
            exit 1
          fi
          mkfs.ext4 -L nfs-data "$dataPart"
          ;;
        ext4)
          case "$fsLabel" in
            nfs-data) ;;
            "") e2label "$dataPart" nfs-data ;;
            *)
              echo "$dataPart is ext4 but has unexpected label $fsLabel" >&2
              exit 1
              ;;
          esac
          ;;
        *)
          echo "$dataPart contains $fsType; refusing to format" >&2
          exit 1
          ;;
      esac

      labeledPart=$(blkid -L nfs-data 2>/dev/null || true)
      if [ -z "$labeledPart" ] || [ "$(readlink -f "$labeledPart")" != "$(readlink -f "$dataPart")" ]; then
        echo "nfs-data resolves to $labeledPart, expected $dataPart" >&2
        exit 1
      fi

      mkdir -p /nfs/data
      mountpoint -q /nfs/data || mount "$dataPart" /nfs/data
    '';
  };

  # A failed grow/partition operation must stop Nix registration and NFS setup;
  # ordering alone would let those units continue after a failed oneshot.
  systemd.services.register-nix-paths = {
    requires = [ "grow-root-and-partition-storage.service" ];
    after = [ "grow-root-and-partition-storage.service" ];
  };
  systemd.services.nfs-data-directories = {
    requires = [ "grow-root-and-partition-storage.service" ];
    after = [ "grow-root-and-partition-storage.service" ];
  };
}
