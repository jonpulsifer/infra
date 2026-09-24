# Homelab live installer

This is the live NixOS installer of jonpulsifer/infra. `homelab-install` erases
one disk and installs a host from the flake, and the motd lists the hosts it can
install. The full procedure is Add a Kubernetes node:
https://wiki.lolwtf.ca/runbooks/add-a-kubernetes-node/

## Install a host

1. Connect to the network. DHCP is automatic, and `ip a` shows the address. For
   Wi-Fi, use `wpa_cli`.
2. List the disks with `lsblk`.
3. Run the install script:

   ```
   sudo homelab-install <host>
   ```

   The script prints the target disk, which is `homelab.disko.device` in the
   host configuration, and asks you to type the host name. It then erases the
   disk, partitions and formats it, mounts it at `/mnt`, and installs NixOS
   from `github:jonpulsifer/infra`. To install from a branch or a local
   checkout, add a second argument:

   ```
   sudo homelab-install <host> github:jonpulsifer/infra/<branch>
   sudo homelab-install <host> <path-to-checkout>
   ```

4. Reboot with `sudo reboot`.

## What the script runs

```
sudo disko --mode destroy,format,mount --flake github:jonpulsifer/infra#<host>
sudo nixos-install --flake github:jonpulsifer/infra#<host> --no-root-passwd
```

## Disk layout

`nix/disko/default.nix` defines one GPT disk, EFI only, with systemd-boot:

- `ESP`: 512M, vfat, `/boot` (`umask=0077`)
- `nixos`: `homelab.disko.rootSize` (default 100G), ext4, `/`
- `storage`: the rest of the disk, ext4, `/mnt/disks` (`nofail,relatime`)

`nix/hosts/<host>.nix` sets `homelab.disko.device` and
`homelab.disko.rootSize`. Change them there before you install a host with
different hardware.
