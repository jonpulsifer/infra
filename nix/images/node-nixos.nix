# The NixOS node image a folly `nixos` class installs: a GPT disk image with an EFI system partition
# that holds one UKI at the removable path and an ext4 root that grows into the disk on first boot.
# .github/workflows/node-images.yml builds it, signs the UKI with the lab's UKI key, compresses it
# and pins the release in clusters/folly/fleet/classes.json; the provision-image Template writes it
# to the node's disk and drops fleet-seed.json on the ESP. A Secure Boot node cannot sign a UKI of its
# own, so the image carries no Nix daemon and no switch: an update is a new image.
{
  config,
  lib,
  pkgs,
  modulesPath,
  ...
}:
let
  efiArch = pkgs.stdenv.hostPlatform.efiArch;
  seedFile = "/boot/fleet-seed.json";
  stateDir = "/var/lib/fleet";
  seed = pkgs.writeShellScript "fleet-seed" ''
    set -euo pipefail
    if [ -e ${stateDir}/seed.json ]; then
      exit 0
    fi
    if [ ! -r ${seedFile} ]; then
      echo "no ${seedFile} on the EFI system partition: the install wrote no seed" >&2
      exit 1
    fi
    url=$(jq -er .url ${seedFile})
    code=$(jq -er .code ${seedFile})
    written=$(jq -r '.uuid // ""' ${seedFile})
    uuid=$(tr 'A-F' 'a-f' </sys/class/dmi/id/product_uuid)
    if [ -n "$written" ] && [ "$written" != "$uuid" ]; then
      echo "the seed on the ESP names $written, and this machine is $uuid" >&2
      exit 1
    fi
    tmp=$(mktemp ${stateDir}/seed.XXXXXX)
    trap 'rm -f "$tmp"' EXIT
    # fleetd burns the code on the first acknowledged read, so one fetch is the budget: the retries
    # cover the network coming up, and a 4xx is final.
    curl -fsSL --retry 10 --retry-delay 6 --retry-connrefused --max-time 60 \
      --get --data-urlencode "uuid=$uuid" --data-urlencode "code=$code" \
      --output "$tmp" "$url"
    jq -e '.version == 1 and (.name | length > 0)' "$tmp" >/dev/null
    mv "$tmp" ${stateDir}/seed.json
    trap - EXIT
    name=$(jq -r .name ${stateDir}/seed.json)
    hostnamectl hostname --transient "$name"
    echo "seed stored for $name: class $(jq -r .class ${stateDir}/seed.json), profile $(jq -r .profile ${stateDir}/seed.json)"
    rm -f ${seedFile}
  '';
in
{
  imports = [
    (modulesPath + "/image/repart.nix")
    ../hardware/x86
  ];

  system.image.id = "nixos-node";
  system.name = "nixos-node";

  image.repart = {
    name = "nixos-node";
    sectorSize = 512;
    partitions = {
      "10-esp" = {
        contents."/EFI/BOOT/BOOT${lib.toUpper efiArch}.EFI".source =
          "${config.system.build.uki}/${config.system.boot.loader.ukiFile}";
        repartConfig = {
          Type = "esp";
          Format = "vfat";
          Label = "ESP";
          SizeMinBytes = "512M";
          SizeMaxBytes = "512M";
        };
      };
      "20-root" = {
        storePaths = [ config.system.build.toplevel ];
        repartConfig = {
          Type = "root";
          Format = "ext4";
          Label = "root";
          Minimize = "guess";
          GrowFileSystem = true;
        };
      };
    };
  };

  fileSystems = {
    "/" = {
      device = "/dev/disk/by-partlabel/root";
      fsType = "ext4";
      autoResize = true;
    };
    "/boot" = {
      device = "/dev/disk/by-partlabel/ESP";
      fsType = "vfat";
      options = [ "umask=0077" ];
    };
  };

  boot = {
    # The firmware loads the UKI from the removable path; no loader writes the ESP after the build.
    loader = {
      grub.enable = false;
      systemd-boot.enable = false;
      efi.canTouchEfiVariables = false;
    };
    initrd = {
      systemd.enable = true;
      # The root partition grows to the disk, then x-systemd.growfs (autoResize) grows ext4 into it.
      systemd.repart.enable = true;
      availableKernelModules = [
        "nvme"
        "sd_mod"
        "virtio_pci"
        "virtio_blk"
        "virtio_scsi"
      ];
    };
    kernelParams = [
      "console=ttyS0,115200"
      "console=tty0"
    ];
  };

  systemd.repart.partitions = {
    "10-esp".Type = "esp";
    "20-root" = {
      Type = "root";
      GrowFileSystem = true;
    };
  };

  # The image is what the node runs: no Nix store database comes with it, so a collector would
  # delete the store, and no switch can change the signed UKI. The nightly upgrade would try both.
  nix.enable = false;
  nix.gc.automatic = lib.mkForce false;
  system.switch.enable = false;
  system.autoUpgrade.enable = false;

  # No static hostname: hostnamed keeps a static one over any transient one, and the seed sets the
  # node's name as a transient hostname on first boot.
  networking.hostName = "";

  environment.systemPackages = with pkgs; [
    curl
    jq
  ];

  # The install wrote the seed's address on the ESP. The first boot fetches the seed once, keeps it
  # for the units that read it, names the host, and removes the address; a later boot finds the
  # stored seed and does nothing.
  systemd.services.fleet-seed = {
    description = "Fetch the fleet seed on first boot";
    unitConfig = {
      ConditionPathExists = "!${stateDir}/seed.json";
      RequiresMountsFor = [
        "/boot"
        stateDir
      ];
      StartLimitIntervalSec = 0;
    };
    after = [ "network-online.target" ];
    wants = [ "network-online.target" ];
    wantedBy = [ "multi-user.target" ];
    path = [
      pkgs.coreutils
      pkgs.curl
      pkgs.jq
      pkgs.systemd
    ];
    serviceConfig = {
      Type = "oneshot";
      RemainAfterExit = true;
      Restart = "on-failure";
      RestartSec = 15;
      StateDirectory = "fleet";
      StateDirectoryMode = "0700";
      UMask = "0077";
      ExecStart = seed;
    };
  };
}
