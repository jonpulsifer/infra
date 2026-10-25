# /home lives on its own VHDX, so the distro can be replaced without losing home. WSL forgets an attached
# disk at every shutdown, so a unit attaches it on each boot before /home mounts. The mount is required: a
# missing disk stops the boot instead of handing out an empty /home on the root disk.
{
  config,
  lib,
  pkgs,
  ...
}:
let
  cfg = config.homelab.wsl;
  label = "nixos-home";
  wslExe = "${config.wsl.wslConf.automount.root}/c/Windows/System32/wsl.exe";
  user = config.users.users.${config.wsl.defaultUser};

  wsl-home-init = pkgs.writeShellApplication {
    name = "wsl-home-init";
    runtimeInputs = [
      pkgs.qemu-utils
      pkgs.e2fsprogs
      pkgs.util-linux
      pkgs.coreutils
      pkgs.systemd
    ];
    text = ''
      disk='${cfg.homeDisk}'
      if [ -e /dev/disk/by-label/${label} ]; then
        echo "The home disk is already attached."
        exit 0
      fi
      path=$(/bin/wslpath -u "$disk")
      if [ -e "$path" ]; then
        echo "$disk exists but is not attached. Run: systemctl restart wsl-home-disk" >&2
        exit 1
      fi

      before=$(lsblk -dnro NAME | sort)
      qemu-img create -q -f vhdx -o subformat=dynamic,block_size=1M "$path" ${cfg.homeDiskSize}
      ${wslExe} --mount --vhd "$disk" --bare
      udevadm settle
      new=$(comm -13 <(echo "$before") <(lsblk -dnro NAME | sort))
      if [ "$(wc -w <<<"$new")" -ne 1 ] || blkid "/dev/$new" >/dev/null; then
        echo "Cannot tell which disk is the new one; formatting nothing." >&2
        exit 1
      fi
      mkfs.ext4 -q -L ${label} "/dev/$new"

      mnt=$(mktemp -d)
      mount "/dev/$new" "$mnt"
      install -d -m 0700 -o ${toString user.uid} -g ${user.group} "$mnt/${config.wsl.defaultUser}"
      umount "$mnt"
      rmdir "$mnt"
      echo "Created $disk. Restart the distro to mount it on /home: wsl.exe --terminate ''${WSL_DISTRO_NAME:-NixOS}"
    '';
  };
in
{
  options.homelab.wsl = {
    homeDisk = lib.mkOption {
      type = lib.types.str;
      default = ''D:\WSL\home.vhdx'';
      description = "Windows path of the VHDX that holds /home.";
    };
    homeDiskSize = lib.mkOption {
      type = lib.types.str;
      default = "1T";
      description = "Largest size wsl-home-init gives a new home VHDX. The file grows as it fills.";
    };
  };

  config = {
    environment.systemPackages = [ wsl-home-init ];

    systemd.services.wsl-home-disk = {
      description = "Attach the home VHDX";
      # The WSL interop handler that runs wsl.exe is registered again by systemd-binfmt.
      after = [ "systemd-binfmt.service" ];
      before = [ "home.mount" ];
      requiredBy = [ "home.mount" ];
      unitConfig.DefaultDependencies = false;
      serviceConfig = {
        Type = "oneshot";
        RemainAfterExit = true;
      };
      script = ''
        [ -e /dev/disk/by-label/${label} ] && exit 0
        ${wslExe} --mount --vhd '${cfg.homeDisk}' --bare
      '';
    };

    fileSystems."/home" = {
      device = "/dev/disk/by-label/${label}";
      fsType = "ext4";
      options = [ "x-systemd.device-timeout=30s" ];
    };
  };
}
