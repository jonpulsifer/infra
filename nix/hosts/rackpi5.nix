# rackpi5 has one boot path: the Pi 5 EEPROM HTTP-loads a signed boot.img
# through Spore, then stage 1 downloads and verifies the matching squashfs
# before mounting it as the read-only Nix store. The machine has no local
# storage and no NFS/TFTP/SD fallback.
#
# The EEPROM configuration lives outside the Nix closure and is applied by
# hand with `sudo rpi-eeprom-config --edit`:
#
#   BOOT_ORDER=0xf7
#   HTTP_HOST=10.2.0.11
#   HTTP_PATH=spore/api/native-boot/rackpi5
#
# HTTP boot downloads boot.sig and boot.img. The EEPROM must contain the public
# half of Spore's /var/lib/pi-boot-sign/private.pem; stock EEPROM updates erase
# that key, so re-enrol it before rebooting rackpi5 after an EEPROM update.
{
  config,
  lib,
  pkgs,
  modulesPath,
  name,
  ...
}:
let
  lab =
    (builtins.fromJSON (builtins.readFile ../../terraform/network/unifi/folly/lab.tf.json)).locals.lab;
  storeUrl = "http://${lab.hosts.spore}/spore/api/native-boot/rackpi5/nix-store.squashfs";
  roStoreMount = "sysroot-nix-.ro\\x2dstore.mount";
  # This key authenticates only the stage-1 debug sshd of a stateless image on
  # the lab VLAN. It is intentionally ephemeral and embedded in boot.img.
  initrdSshHostKey = pkgs.runCommand "initrd-ssh-hostkey" { nativeBuildInputs = [ pkgs.openssh ]; } ''
    mkdir $out
    ssh-keygen -q -t ed25519 -N "" -C rackpi5-initrd -f $out/key
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

  users.users = {
    root.initialHashedPassword = lib.mkForce null;
    nixos.initialHashedPassword = lib.mkForce null;
  };
  services.openssh.settings.PermitRootLogin = lib.mkForce "no";

  boot.loader.raspberry-pi.bootloader = "kernel";
  fileSystems."/nix/.ro-store".device = lib.mkForce "/nix-store.squashfs";

  boot.initrd.systemd = {
    extraBin = {
      curl = "${pkgs.curl}/bin/curl";
      mv = "${pkgs.coreutils}/bin/mv";
      sed = "${pkgs.gnused}/bin/sed";
      sha256sum = "${pkgs.coreutils}/bin/sha256sum";
    };
    network = {
      enable = true;
      networks."10-end0" = {
        matchConfig.Name = "end0";
        networkConfig.DHCP = "ipv4";
      };
    };
    services.fetch-nix-store = {
      description = "Fetch and verify the squashfs Nix store from Spore";
      requiredBy = [ roStoreMount ];
      before = [ roStoreMount ];
      wants = [ "systemd-networkd-wait-online.service" ];
      after = [ "systemd-networkd-wait-online.service" ];
      unitConfig.DefaultDependencies = false;
      serviceConfig = {
        Type = "oneshot";
        RemainAfterExit = true;
      };
      script = ''
        expected=$(sed -n 's/.*spore.squashfs-sha256=\([0-9a-f]\{64\}\).*/\1/p' /proc/cmdline)
        if [ -z "$expected" ]; then
          echo "signed boot command line has no squashfs checksum" >&2
          exit 1
        fi

        verify_store() {
          echo "$expected  $1" | sha256sum --check -
        }

        if [ -s /nix-store.squashfs ] && verify_store /nix-store.squashfs; then
          exit 0
        fi

        curl --fail --retry 10 --retry-connrefused --retry-delay 2 \
          -o /nix-store.squashfs.partial "${storeUrl}?sha256=$expected"
        verify_store /nix-store.squashfs.partial
        mv /nix-store.squashfs.partial /nix-store.squashfs
      '';
    };

    services.initrd-ssh-hostkey = {
      description = "Install the initrd sshd host key with strict permissions";
      before = [ "sshd.service" ];
      requiredBy = [ "sshd.service" ];
      unitConfig.DefaultDependencies = false;
      serviceConfig.Type = "oneshot";
      script = "install -m 600 /etc/ssh/initrd_host_key_ro /etc/ssh/initrd_host_key";
    };
    contents."/etc/ssh/initrd_host_key_ro".source = "${initrdSshHostKey}/key";
    # Recovery remains key-authenticated over initrd SSH; do not expose an
    # unauthenticated emergency shell on the physical console.
    emergencyAccess = false;
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
    pkgs.runCommand "rackpi5-boot-img"
      {
        nativeBuildInputs = with pkgs; [
          dosfstools
          mtools
          util-linux
        ];
      }
      ''
        mkdir staging
        ${config.boot.loader.raspberry-pi.firmwarePopulateCmd} \
          -c ${config.system.build.toplevel} -f ./staging

        chmod -R u+w staging
        rm -f staging/bootcode.bin staging/start*.elf staging/fixup*.dat

        mv staging/nixos/default/* staging/
        rm -rf staging/nixos
        sed -i "/^os_prefix=/d" staging/config.txt

        # The signed image pins its content-addressed root. Spore serves old
        # roots by digest, so activation cannot mix boot and root generations.
        checksum=$(sha256sum ${config.system.build.squashfsStore} | cut -d ' ' -f 1)
        sed -i 's/ spore\.squashfs-sha256=[0-9a-f]\{64\}//g' staging/cmdline.txt
        printf '%s spore.squashfs-sha256=%s\n' \
          "$(tr -d '\r\n' < staging/cmdline.txt)" "$checksum" \
          > staging/cmdline.pinned.txt
        mv staging/cmdline.pinned.txt staging/cmdline.txt

        size_kib=$(du -s --apparent-size --block-size=1024 staging | cut -f1)
        size_kib=$(( size_kib + size_kib / 10 + 8192 ))
        mkdir -p $out
        truncate -s "''${size_kib}K" $out/boot.img
        echo "start=1, type=c, bootable" | sfdisk --no-reread --no-tell-kernel $out/boot.img
        mkfs.vfat --offset 1 -F 32 -n BOOT $out/boot.img
        (cd staging && mcopy -psvm -i "$out/boot.img@@512" ./* ::/ > /dev/null)

        # boot.sig is generated on Spore at publication time. The private key
        # never enters this derivation or the Nix store.
        ln -s ${config.system.build.squashfsStore} $out/nix-store.squashfs
      '';
}
