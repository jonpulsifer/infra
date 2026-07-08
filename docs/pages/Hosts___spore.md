type:: host
role:: NFS / PXE boot server
vendor:: Raspberry Pi
model:: Raspberry Pi 5 Model B Rev 1.1 (8 GB)
year:: ~2023
serial:: d860ec5f943fe335
revision:: d04171
cpu:: BCM2712, Cortex-A76 (4c)
ram:: 8 GB LPDDR4X-4267
gpu:: Broadcom VideoCore VII
storage:: 128 GB Patriot P300 NVMe (root 32 GB, 35% used)
os:: NixOS 26.05 (Yarara)

- NFS/PXE boot server — **boot-critical for [[Hosts/rackpi5]]** ([[ADR/0008 Diskless netboot for rackpi5]]); monitored by folly.
- Only Pi with NVMe storage (128 GB Patriot P300). Config: `nix/hosts/spore.nix`.
- Reached as `spore.lolwtf.ca`.
- See [[Fleet]] for the full inventory.
