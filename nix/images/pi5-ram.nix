# Stateless RAM-booted Pi 5 image, delivered in two stages because the
# bootloader's native HTTP boot (BOOT_ORDER digit 7) is small and slow: it
# loads boot.img into a fixed ~180MiB RAM window at ~2.6MB/s (measured --
# a 764MB all-in-one image aborted at exactly 189MB), so the bootloader
# only pulls a small boot.img (firmware + kernel + stock initrd, ~80MB),
# and stage-1 then curls the ~700MB squashfs nix store at real wire speed
# and loop-mounts it from RAM. Nothing persists across reboots, including
# host keys.
#
# This is the aarch64 sibling of nix/images/netboot.nix: same
# netboot-minimal squashfs profile, but instead of an iPXE script the
# payload is `system.build.piBootImg` (boot.img + nix-store.squashfs),
# copied to /var/lib/tftpboot/rackpi5-ram on spore (whose nginx serves it)
# and RSA-signed there -- see the note at the bottom of this file.
#
# rackpi5 boots this by default; its EEPROM settings are documented in
# nix/hosts/rackpi5.nix.
{
  config,
  lib,
  pkgs,
  modulesPath,
  name,
  ...
}:
let
  # spore's Lab-net IP comes from the network SSOT (see nix/services/k8s/networks.nix).
  spore =
    (builtins.fromJSON (builtins.readFile ../../clusters/folly/config/cluster-topology.json))
    .data.SPORE_IP;
  storeUrl = "http://${spore}/rackpi5-ram/nix-store.squashfs";
  # systemd-escape -p /sysroot/nix/.ro-store
  roStoreMount = "sysroot-nix-.ro\\x2dstore.mount";
  # Deliberately world-readable (it lives in the store and inside the
  # unencrypted boot.img anyway): this key only authenticates the stage-1
  # debug sshd of a stateless image on the lab VLAN, not a real host
  # identity. The usual boot.initrd.secrets append doesn't run here -- the
  # nixos-raspberrypi bootloader copies the initrd verbatim.
  initrdSshHostKey =
    pkgs.runCommand "initrd-ssh-hostkey" { nativeBuildInputs = [ pkgs.openssh ]; }
      ''
        mkdir $out
        ssh-keygen -q -t ed25519 -N "" -C rackpi5-ram-initrd -f $out/key
      '';
in
{
  imports = [
    (modulesPath + "/installer/netboot/netboot-minimal.nix")
    ../hardware/pi5/base.nix
  ];

  networking = {
    hostName = name;
    wireless.enable = lib.mkForce false;
    useDHCP = lib.mkForce true;
  };

  # Remove initialHashedPassword for root and nixos (installer profile)
  users.users = {
    root.initialHashedPassword = lib.mkForce null;
    nixos.initialHashedPassword = lib.mkForce null;
  };

  # why is this a thing that exists
  services.openssh.settings.PermitRootLogin = lib.mkForce "no";

  # auto log me in
  services.getty.autologinUser = lib.mkForce config.users.users.jawn.name;

  # The generational "kernel" bootloader normally comes as a default from
  # the sd-image module, which this image doesn't import; its populate
  # command is what lays out config.txt/kernel/initrd/DTBs for boot.img.
  boot.loader.raspberry-pi.bootloader = "kernel";

  # The netboot profile expects the squashfs inside the initrd
  # ("../nix-store.squashfs"); ours is downloaded by the fetch service
  # below into the initrd rootfs instead.
  fileSystems."/nix/.ro-store".device = lib.mkForce "/nix-store.squashfs";

  # Same systemd stage-1 networking recipe as the NFS tier in
  # nix/hosts/rackpi5.nix, plus curl to pull the store.
  boot.initrd.systemd = {
    extraBin.curl = "${pkgs.curl}/bin/curl";
    network = {
      enable = true;
      networks."10-end0" = {
        matchConfig.Name = "end0";
        networkConfig.DHCP = "ipv4";
      };
    };
    services.fetch-nix-store = {
      description = "Fetch the squashfs nix store from spore over HTTP";
      requiredBy = [ roStoreMount ];
      before = [ roStoreMount ];
      wants = [ "systemd-networkd-wait-online.service" ];
      after = [ "systemd-networkd-wait-online.service" ];
      unitConfig.DefaultDependencies = false;
      serviceConfig = {
        Type = "oneshot";
        # Without this, any later re-trigger of the .ro-store mount
        # re-runs the unit and re-downloads the whole store.
        RemainAfterExit = true;
      };
      script = ''
        [ -s /nix-store.squashfs ] && exit 0
        curl --fail --retry 10 --retry-connrefused --retry-delay 2 \
          -o /nix-store.squashfs ${storeUrl}
      '';
    };

    # Stage-1 debug shell: `ssh -p 2222 root@10.2.0.12` while the initrd is
    # up, since this Pi has no reachable console.
    services.initrd-ssh-hostkey = {
      description = "Install the initrd sshd host key with the perms sshd demands";
      before = [ "sshd.service" ];
      requiredBy = [ "sshd.service" ];
      unitConfig.DefaultDependencies = false;
      serviceConfig.Type = "oneshot";
      script = "install -m 600 /etc/ssh/initrd_host_key_ro /etc/ssh/initrd_host_key";
    };
    contents."/etc/ssh/initrd_host_key_ro".source = "${initrdSshHostKey}/key";
    emergencyAccess = true;
  };
  boot.initrd.network.ssh = {
    enable = true;
    port = 2222;
    ignoreEmptyHostKeys = true;
    authorizedKeys = config.users.users.jawn.openssh.authorizedKeys.keys;
    extraConfig = "HostKey /etc/ssh/initrd_host_key";
  };
  boot.kernelParams = [ "ip=dhcp" ];

  system.build.piBootImg =
    pkgs.runCommand "pi5-ram-boot-img"
      {
        nativeBuildInputs = with pkgs; [
          dosfstools
          mtools
          openssl
          raspberrypi-eeprom
          util-linux
        ];
      }
      ''
        # Lay out the firmware tree exactly as the TFTP/sd-image path would:
        # config.txt with os_prefix=nixos/default/, kernel.img, cmdline.txt
        # (kernel-params + init=<toplevel>), DTBs, overlays. The stock
        # initrd is all we need -- the squashfs is fetched at boot, not
        # embedded -- which is what keeps boot.img inside the bootloader's
        # ~180MiB HTTP-boot window.
        mkdir staging
        ${config.boot.loader.raspberry-pi.firmwarePopulateCmd} \
          -c ${config.system.build.toplevel} -f ./staging

        # The populate script also copies Pi 4-era GPU boot code
        # (bootcode.bin/start*.elf/fixup*.dat) that the Pi 5's EEPROM never
        # reads; the bootloader caps ramdisks at 96MB, so every megabyte
        # counts.
        chmod -R u+w staging
        rm -f staging/bootcode.bin staging/start*.elf staging/fixup*.dat

        # Match the layout of the official boot.img (usbboot's
        # mass-storage-gadget64 / the network-install image): everything at
        # the FAT root with no os_prefix indirection -- the ramdisk boot
        # path rejected our generational os_prefix=nixos/default/ layout.
        mv staging/nixos/default/* staging/
        rm -rf staging/nixos
        sed -i "/^os_prefix=/d" staging/config.txt

        # ... and the official container format: an MBR (single bootable
        # FAT32-LBA partition starting at sector 1) around the filesystem,
        # not a bare "superfloppy" FAT -- the other observed difference vs
        # the boot.img the bootloader accepts.
        size_kib=$(du -s --apparent-size --block-size=1024 staging | cut -f1)
        size_kib=$(( size_kib + size_kib / 10 + 8192 ))
        mkdir -p $out
        truncate -s "''${size_kib}K" $out/boot.img
        echo "start=1, type=c, bootable" | sfdisk --no-reread --no-tell-kernel $out/boot.img
        mkfs.vfat --offset 1 -F 32 -n BOOT $out/boot.img
        (cd staging && mcopy -psvm -i "$out/boot.img@@512" ./* ::/ > /dev/null)

        # No boot.sig here: ALL bootloader HTTP downloads must be
        # RSA-signed with a key whose public half is programmed into the
        # EEPROM (a bare sha256 sig is rejected -- learned by watching four
        # perfectly good downloads get discarded). The private key must
        # stay out of the store, so signing happens at deploy time on
        # spore:
        #   rpi-eeprom-digest -i boot.img -o boot.sig \
        #     -k /var/lib/pi-boot-sign/private.pem

        # Served next to boot.img; stage-1 curls it (see fetch-nix-store).
        ln -s ${config.system.build.squashfsStore} $out/nix-store.squashfs
      '';
}
