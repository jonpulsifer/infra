# spore: NVMe-rooted Pi 5 serving NFS, PXE, native-boot artifacts, Talos boot assets, DNS and NTP.
# First boot grows root to a fixed cap and gives the disk tail to the nfs-data partition at /nfs/data.
{
  config,
  lib,
  pkgs,
  ...
}:
let
  # The EK public key hash read on each node that attests by EK, the fallback for a node with no
  # LDevID (docs/platform/identity.md).
  ekHashes = {
    optiplex = "1fa41a06cb1425a5cf723b50273f38cbe992400ba1109e406baa92f97646fb14";
    riptide = "a4c83508a80e37c4c10334e4ecd951fe7aef56ce757b9a40e8a4e38be146b3b1";
  };
  # With tpm_devid on, a node attests by the LDevID that the attest service issues it, whose subject
  # CN is the node's name. SPIRE 1.15.5's tpm_devid gives selectors for the subject's CN only, not
  # its OU (the class) or O (the site), so each node in the nodes file with a TPM 2.0 gets its own
  # alias, and a new node needs a spore deploy. A failed or retired node keeps its alias until its
  # entry goes, and talos-attest refuses it an LDevID.
  devidNodes = lib.attrNames (
    lib.filterAttrs (_: n: n.tpm or null == "2.0") (import ../lib/inventory.nix { inherit lib; })
  );
  tpmNodes = lib.sort lib.lessThan (lib.unique (lib.attrNames ekHashes ++ devidNodes));
  trustDomain = config.homelab.spire.trustDomain;
  nodeID = name: "spiffe://${trustDomain}/node/${name}";
  # One alias per node and attestor: an agent matches a node entry only when it has every selector.
  nodeAliases =
    lib.mapAttrsToList (name: hash: {
      spiffeID = nodeID name;
      selectors = [ "tpm:pub_hash:${hash}" ];
    }) ekHashes
    ++ lib.optionals config.homelab.spire.devid.enable (
      map (name: {
        spiffeID = nodeID name;
        key = "tpm_devid";
        selectors = [ "tpm_devid:subject:cn:${name}" ];
      }) devidNodes
    );
  # Kubernetes service accounts that get an SVID on every TPM node.
  workloads = [
    {
      ns = "spire-smoke";
      sa = "smoke";
    }
    {
      ns = "spire-test";
      sa = "uploader";
    }
    {
      ns = "spire-oidc";
      sa = "oidc-discovery-provider";
    }
  ];
in
{
  imports = [
    ../profiles/anchor.nix
    ../profiles/pi5-nvme.nix
    ../services/fleet-controller.nix
    ../services/garage.nix
    ../services/nfs-server.nix
    ../services/pxe-netboot.nix
    ../services/spire-server.nix
    ../services/spore-native-boot.nix
    ../services/tinkerbell.nix
    ../system/sops.nix
  ];

  # A worker provision installs Talos from HookOS; /render serves the config. On once the
  # installer release and the tink-attest digest that writes the code are live.
  homelab.fleetController.installs = true;

  # This board and drive run stable at Gen 3, above nvme-hat.nix's Gen 2 default.
  hardware.raspberry-pi.config.pi5.base-dt-params.pciex1_gen = {
    enable = true;
    value = 3;
  };

  homelab.nfsServer.dataDevice = "/dev/disk/by-label/nfs-data";

  # The YubiKey 5 that holds one of the two hardware DevID CA keys.
  homelab.devidCa.yubikey.enable = true;
  homelab.devidCa.yubikey.serial = 9758244;
  # The attest service signs LDevIDs with this anchor's YubiKey CA.
  homelab.talosAttest.caKey = "pkcs11";

  # A node of the anchors' three-node cluster. The standalone store's /nfs/data/garage stays on
  # disk as the rollback (docs/runbooks/migrate-garage-to-three-nodes.md).
  homelab.garage = {
    enable = true;
    site = "folly";
    dataDir = "/nfs/data/garage-ha";
    clustered = true;
  };

  homelab.spire = {
    bundleNotifier.enable = true;
    enable = true;
    ekHashes = lib.attrValues ekHashes;
    # Each issuing DevID CA's own certificate file, never the bundle: the server trusts the first
    # certificate of each file.
    devid.enable = true;
    devid.caChains = [
      ../../terraform/pki/certs/folly-devid-ca-software.pem
      ../../terraform/pki/certs/folly-devid-ca-spore.pem
      ../../terraform/pki/certs/folly-devid-ca-capsule.pem
    ];
    entries =
      nodeAliases
      ++ lib.concatMap (
        name:
        map (w: {
          spiffeID = "spiffe://${trustDomain}/ns/${w.ns}/sa/${w.sa}";
          parentID = nodeID name;
          selectors = [
            "k8s:ns:${w.ns}"
            "k8s:sa:${w.sa}"
          ];
        }) workloads
      ) tpmNodes;
  };

  sops.defaultSopsFile = ../secrets/spore.sops.yaml;

  # Root is capped at 32G and each generation carries a ~1G rackpi5 boot image, so same-day
  # deploys fill it. GC keeps 7 days, and first trims the system profile to the current
  # generation and 3 before it. spore has no generation menu, so no bootloader limit applies.
  nix.gc = {
    dates = "daily";
    options = "--delete-older-than 7d";
  };
  systemd.services.nix-gc.preStart = ''
    ${config.nix.package}/bin/nix-env --profile /nix/var/nix/profiles/system --delete-generations +4
  '';

  # The rackpi5 target is wired in nix/lib/registry.nix, where its piBootImg is in scope.
  services.spore.enable = true;

  # Paths no unit reads, about 2G that the capped root cannot spare. The Talos boot mirror keeps its
  # releases under /var/lib/talos-boot (../services/talos-boot.nix).
  systemd.tmpfiles.rules = [
    "R /var/lib/spore-talos-boot"
    "r /var/lib/prometheus-node-exporter-text-files/spore-talos-boot.prom"
  ];

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
