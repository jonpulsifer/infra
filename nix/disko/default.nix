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

  # disko generates fileSystems that mount by partlabel: disk-main-{ESP,nixos,storage}.
  config.disko.devices.disk.main = {
    type = "disk";
    device = cfg.device;
    content = {
      type = "gpt";
      partitions = {
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
        nixos = {
          priority = 2;
          size = cfg.rootSize;
          content = {
            type = "filesystem";
            format = "ext4";
            mountpoint = "/";
          };
        };
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
