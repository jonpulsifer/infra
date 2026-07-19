type:: host
role:: rack status display
vendor:: Raspberry Pi
model:: Raspberry Pi 5 Model B Rev 1.1 (8 GB)
year:: ~2023
serial:: aed421e548c12e74
revision:: d04171
cpu:: BCM2712, Cortex-A76 (4c)
ram:: 8 GB LPDDR4X-4267
gpu:: Broadcom VideoCore VII
storage:: none — diskless (root is a 4 GB tmpfs)
os:: NixOS 26.05 (Yarara), RAM image

- **Diskless**: Pi EEPROM HTTP-boots the signed `rackpi5` RAM image through [[Hosts/spore]] and runs entirely from RAM (`lsblk` shows no disks). See [[ADR/0008 Diskless netboot for rackpi5]].
- The only EEPROM boot mode is HTTP (`BOOT_ORDER=0xf7`, `HTTP_HOST=10.2.0.11`, `HTTP_PATH=spore/api/native-boot/rackpi5`). Spore serves `boot.sig`, `boot.img`, and a digest-addressed `nix-store.squashfs`; stage 1 verifies the squashfs digest anchored in the signed command line.
- There is intentionally no NFS, TFTP, SD, or UEFI fallback. Deploy and validate Spore's publisher before applying the EEPROM cutover; physical EEPROM recovery is required if the sole path is misconfigured.
- Reached as `rackpi5.lolwtf.ca`. Config: `nix/hosts/rackpi5.nix`.
- See [[Fleet]] for the full inventory.
