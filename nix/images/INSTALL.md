# Homelab live installer

You are booted into the jonpulsifer/infra live NixOS installer.

## Quick install (disko)

1. Get on the network — DHCP is automatic, check with `ip a`. For Wi-Fi use `wpa_cli`.
2. Identify the target disk: `lsblk`
3. Install this host:

   ```
   sudo homelab-install <host>
   ```

   | host      | disk           | cluster / role          |
   |-----------|----------------|-------------------------|
   | optiplex  | /dev/sda       | folly, control-plane    |
   | riptide   | /dev/nvme0n1   | folly                   |
   | shale     | /dev/sda       | folly                   |
   | oldschool | /dev/sda       | offsite                 |
   | retrofit  | /dev/sda       | offsite, control-plane  |

   This DESTROYS the target disk, partitions it (GPT: boot → nixos → storage),
   formats, mounts at `/mnt`, and installs NixOS. Config is pulled from
   `github:jonpulsifer/infra` by default.

   Install from a branch or a local checkout instead:

   ```
   sudo homelab-install riptide github:jonpulsifer/infra/my-branch
   sudo homelab-install riptide /mnt/infra
   ```

4. Reboot: `sudo reboot`

## Manual steps (what homelab-install runs)

```
sudo disko --mode destroy,format,mount --flake github:jonpulsifer/infra#<host>
sudo nixos-install --flake github:jonpulsifer/infra#<host> --no-root-passwd
sudo reboot
```

## Remote install (from your laptop; target booted into this ISO)

```
nix run github:nix-community/nixos-anywhere -- \
  --flake .#<host> --target-host root@<ip>
```

## Layout

GPT, EFI-only, single disk per host (systemd-boot):

- `ESP`     — 512M, vfat, `/boot` (`umask=0077`), type EF00
- `nixos`   — 100G, ext4, `/`
- `storage` — rest, ext4, `/mnt/disks` (`nofail,relatime`)

The target disk and root size come from `homelab.disko.{device,rootSize}` in the
host config (see `nix/disko/default.nix`). Adjust in `flake.nix` before installing
if a host's hardware differs.
