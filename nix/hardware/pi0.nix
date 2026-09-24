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

  # GPIO tooling for the pHAT BEAT (radiopi0) and Blinkt! (blinkypi0) HATs.
  environment.systemPackages = [ pkgs.wiringpi ];

  # No board module or binary cache targets the Pi Zero W's armv6l, so cross-compile from aarch64-linux.
  # Use hostPlatform/buildPlatform: nixpkgs asserts against mixing them with localSystem/crossSystem.
  nixpkgs.buildPlatform.system = "aarch64-linux";
  nixpkgs.hostPlatform = lib.systems.examples.raspberryPi;

  # systemd pulls in the EFI-only efivar and efibootmgr on this non-EFI board, and efivar is broken for
  # this cross target. Stub both.
  nixpkgs.overlays = [
    (final: prev: {
      efivar = prev.runCommand "empty-efivar" { } "mkdir $out";
      efibootmgr = prev.runCommand "empty-efibootmgr" { } "mkdir $out";
    })
  ];

  # Required for the Pi Zero W's wifi firmware (bcm43438).
  hardware.enableRedistributableFirmware = true;

  boot = {
    # bcmrpi_defconfig builds drivers for every Pi, and some Pi 5 and DesignWare modules do not link on
    # ARMv6 (__aeabi_{u,}ldivmod is not exported). Keep MMC, USB, wifi, GPIO, SPI, I2C and ASoC.
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

            # Neither host has camera, tuner, sensor/ADC or specialist radio hardware.
            MEDIA_SUPPORT = disabled;
            IIO = disabled;
            BT = disabled;
            CAN = disabled;
            NFC = disabled;
            WWAN = disabled;
            HAMRADIO = disabled;

            # A Pi Zero has no PCMCIA, SATA, RAID or device mapper. SCSI stays
            # for USB mass storage.
            PCCARD = disabled;
            ATA = disabled;
            MD = disabled;
            BLK_DEV_DM = disabled;
          };
      }
    ];

    # The installer profile adds zfs, btrfs, cifs and others; zfs alone is a slow from-source cross build.
    supportedFilesystems = lib.mkForce [
      "ext4"
      "vfat"
    ];

    # The SD host controller is built into the kernel; an ext4 root on SD needs only mmc_block.
    initrd = {
      availableKernelModules = lib.mkForce [ "mmc_block" ];
      kernelModules = lib.mkForce [ ];
    };
  };

  sdImage.compressImage = true;
}
