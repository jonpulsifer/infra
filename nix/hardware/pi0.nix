{
  lib,
  pkgs,
  modulesPath,
  ...
}:
{
  imports = [
    (modulesPath + "/installer/sd-card/sd-image-raspberrypi.nix")
  ];

  # save some space
  documentation.enable = false;

  # GPIO tooling for the LED HATs on this board family (pHAT BEAT on
  # radiopi0, Blinkt! on blinkypi0).
  environment.systemPackages = [ pkgs.wiringpi ];

  # Original Pi Zero W: BCM2835, single-core ARM1176JZF-S (armv6l). No
  # nixos-hardware/nixos-raspberrypi board module targets this chip (those
  # bottom out at Pi 2 / Zero 2 W), and there's no armv6l binary cache
  # anywhere -- everything in this closure compiles from source.
  # nixpkgs.buildPlatform keeps the *build* machine on its own native arch
  # (aarch64-linux on spore) while hostPlatform cross-compiles the armv6l
  # target, no QEMU emulation. Must use the modern hostPlatform/buildPlatform
  # options (matching nix/system/nixos.nix's own hostPlatform default) rather
  # than the legacy localSystem/crossSystem pair -- nixpkgs asserts against
  # mixing the two.
  nixpkgs.buildPlatform.system = "aarch64-linux";
  nixpkgs.hostPlatform = lib.systems.examples.raspberryPi;

  # efivar/efibootmgr are EFI-specific (irrelevant on this non-EFI board) --
  # systemd/dbus pull them in transitively regardless, and efivar is marked
  # broken for this cross target upstream. Stub both out entirely rather than
  # letting the real (likely genuinely broken, not just meta-flagged) cross
  # build run.
  nixpkgs.overlays = [
    (final: prev: {
      efivar = prev.runCommand "empty-efivar" { } "mkdir $out";
      efibootmgr = prev.runCommand "empty-efibootmgr" { } "mkdir $out";
    })
  ];

  # Required for the Pi Zero W's wifi firmware (bcm43438).
  hardware.enableRedistributableFirmware = true;

  boot = {
    # linux_rpi1 starts from Raspberry Pi's broad bcmrpi_defconfig, which
    # enables drivers for every Pi generation and a large collection of
    # unrelated expansion hardware. Some of the Pi 5 / DesignWare modules
    # also emit 64-bit division calls that cannot be linked as ARMv6 kernel
    # modules (__aeabi_{u,}ldivmod is not exported by the kernel).
    #
    # Keep the interfaces these appliances use (MMC, USB, wifi, GPIO,
    # SPI, BCM2835 I2C, and ASoC audio), and trim hardware that cannot exist
    # on an original Pi Zero W or is unused by either attached LED/audio HAT.
    kernelPatches = [
      {
        name = "pi-zero-minimal-kernel-config";
        patch = null;
        structuredExtraConfig =
          let
            disabled = lib.mkForce lib.kernel.no;
          in
          {
            # Pi 4/5 and RP1 peripherals.
            BCM2711_THERMAL = disabled;
            CLK_BCM2711_DVP = disabled;
            PWM_RP1 = disabled;
            SND_RP1_AUDIO_OUT = disabled;
            VIDEO_RP1_CFE = disabled;

            # The Zero uses the BCM2835 I2C controller, not DesignWare.
            I2C_DESIGNWARE_CORE = disabled;
            I2C_DESIGNWARE_PCI = disabled;
            I2C_DESIGNWARE_PLATFORM = disabled;
            I2C_DESIGNWARE_SLAVE = disabled;

            # Neither host has camera, tuner, sensor/ADC, or specialist radio
            # hardware attached.
            MEDIA_SUPPORT = disabled;
            IIO = disabled;
            BT = disabled;
            CAN = disabled;
            NFC = disabled;
            WWAN = disabled;
            HAMRADIO = disabled;

            # An original Pi Zero has no PCMCIA, SATA, RAID, or device mapper.
            # Keep the SCSI core selected by USB mass storage so its USB port
            # remains generally useful.
            PCCARD = disabled;
            ATA = disabled;
            MD = disabled;
            BLK_DEV_DM = disabled;
          };
      }
    ];

    # sd-image-raspberrypi pulls in the generic installer's filesystem set
    # (zfs, btrfs, cifs, f2fs, ntfs, xfs) via profiles/base.nix -- all
    # irrelevant here, and zfs in particular is a large, slow, from-source
    # cross build with no armv6l cache. Only ext4 (root) and vfat (firmware
    # partition) are actually used.
    supportedFilesystems = lib.mkForce [
      "ext4"
      "vfat"
    ];

    # Same installer default pulls in drivers for SATA, NVMe, RAID, virtio,
    # and USB HID devices that don't exist on this board. The Pi Zero W's SD
    # host controller is built into the kernel; only the modular MMC block
    # driver is needed to mount an ext4 root from the SD card.
    initrd = {
      availableKernelModules = lib.mkForce [ "mmc_block" ];
      kernelModules = lib.mkForce [ ];
    };
  };

  sdImage.compressImage = true;
}
