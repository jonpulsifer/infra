type:: host
role:: rack status display
vendor:: Raspberry Pi
model:: Raspberry Pi 5 Model B Rev 1.1 (8 GB)
year:: ~2023
serial:: aed421e548c12e74
revision:: d04171
cpu:: BCM2712, Cortex-A76 (4c)
ram:: 8 GB
storage:: none — diskless
os:: NixOS 26.05 (Yarara), RAM image

- **Diskless**: PXE-netboots the `rackpi5-ram` image from [[Hosts/spore]] and runs entirely from RAM (`lsblk` shows no disks; static hostname is `rackpi5-ram`). See [[ADR/0008 Diskless netboot for rackpi5]].
- Reached as `rackpi5.lolwtf.ca`. Config: `nix/hosts/rackpi5.nix`.
- See [[Fleet]] for the full inventory.
