# rackpi5 is diskless: the Pi 5 bootloader netboots from spore (10.2.0.11,
# nix/hosts/spore.nix). The EEPROM TFTP-loads firmware/kernel/initrd from
# spore's dnsmasq (/var/lib/tftpboot/rackpi5/, which is this host's
# /boot/firmware mounted over NFS -- so every nixos-rebuild here lands
# kernels straight in the netboot tree), and stage-1 mounts / over NFS from
# spore:/nfs/data/rackpi5. The SD card keeps the last standalone image as a
# rescue system; the EEPROM only falls back to it when netboot fails.
#
# Like nvme-hat.nix's settings, the netboot side of the EEPROM lives outside
# the closure and is applied by hand with `sudo rpi-eeprom-config --edit`:
#   BOOT_ORDER=0xf12          # right-to-left: NET first, SD rescue, retry
#   TFTP_IP=10.2.0.11         # spore; Lab Net DHCP has no boot options
#   TFTP_PREFIX=1             # prefix TFTP paths with TFTP_PREFIX_STR
#                             # (0=serial dir, 1=TFTP_PREFIX_STR, 2=MAC dir)
#   TFTP_PREFIX_STR=rackpi5/
{
  lib,
  name,
  pkgs,
  ...
}:
let
  spore = "10.2.0.11";
in
{
  imports = [
    ../hardware/pi5
    ../hardware/pi5/nvme-hat.nix
    ../services/common.nix
  ];

  networking = {
    hostName = name;
    wireless.enable = lib.mkForce false;
  };

  # The sd-image module pins these to the SD partition labels with
  # mkImageMediaOverride (and mkForce for the firmware mount options), so
  # out-prioritizing it needs mkForce / mkOverride 45.
  fileSystems."/" = {
    device = lib.mkForce "${spore}:/nfs/data/rackpi5";
    fsType = lib.mkForce "nfs";
    options = [ "nfsvers=4.2" ];
  };
  fileSystems."/boot/firmware" = {
    device = lib.mkForce "${spore}:/var/lib/tftpboot/rackpi5";
    fsType = lib.mkForce "nfs";
    options = lib.mkOverride 45 [
      "nfsvers=4.2"
      "noatime"
      "noauto"
      "x-systemd.automount"
      "x-systemd.idle-timeout=1min"
    ];
  };

  # This platform uses systemd stage-1, where NFS root needs explicit wiring:
  # nixpkgs' nfs module only ships the kernel module into the initrd, not the
  # mount.nfs helper, and initrd networking is systemd-networkd, not the
  # scripted stage-1's boot.initrd.network/ipconfig (those options build fine
  # but wire nothing here -- learned the hard way, the first netboot hung in
  # stage-1 with no NIC config and no way to mount /sysroot).
  boot.initrd = {
    supportedFilesystems.nfs = true;
    # nfs.ko comes via supportedFilesystems; v4 is a separate module the
    # sysroot mount needs. macb is the Pi 5 NIC (Cadence GEM in the RP1).
    kernelModules = [ "nfsv4" ];
    availableKernelModules = [ "macb" ];
    systemd = {
      extraBin."mount.nfs" = "${pkgs.nfs-utils}/bin/mount.nfs";
      network = {
        enable = true;
        networks."10-end0" = {
          matchConfig.Name = "end0";
          networkConfig.DHCP = "ipv4";
        };
      };
    };
  };
  # Belt and braces: systemd-network-generator also honours ip=dhcp, and
  # UniFi pins this MAC to 10.2.0.12 so stage 2's dhcpcd re-acquires the
  # same address without disturbing the NFS mounts.
  boot.kernelParams = [ "ip=dhcp" ];
}
