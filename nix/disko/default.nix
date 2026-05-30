{
  inputs,
  config,
  lib,
  ...
}:
let
  cfg = config.homelab.disko;
in
{
  imports = [ inputs.disko.nixosModules.disko ];

  options.homelab.disko = {
    device = lib.mkOption {
      type = lib.types.str;
      default = "/dev/sda";
      description = "Whole-disk device to partition for this host.";
    };
    rootSize = lib.mkOption {
      type = lib.types.str;
      default = "100G";
      description = "Size of the root partition; storage takes the rest.";
    };
  };

  # GPT, EFI-only. disko owns the partitioning and generates fileSystems
  # (by-partlabel: /dev/disk/by-partlabel/disk-main-{ESP,nixos,storage}).
  config.disko.devices.disk.main = {
    type = "disk";
    device = cfg.device;
    content = {
      type = "gpt";
      partitions = {
        # EFI system partition; systemd-boot is installed here.
        ESP = {
          priority = 1;
          size = "512M";
          type = "EF00";
          content = {
            type = "filesystem";
            format = "vfat";
            mountpoint = "/boot";
            mountOptions = [ "umask=0077" ];
          };
        };
        # Root.
        nixos = {
          priority = 2;
          size = cfg.rootSize;
          content = {
            type = "filesystem";
            format = "ext4";
            mountpoint = "/";
          };
        };
        # Bulk storage fills the remainder of the disk.
        storage = {
          priority = 3;
          size = "100%";
          content = {
            type = "filesystem";
            format = "ext4";
            mountpoint = "/mnt/disks";
            mountOptions = [
              "nofail"
              "relatime"
            ];
          };
        };
      };
    };
  };
}
