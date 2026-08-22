type:: host
vendor:: HP
model:: EliteDesk 800 G5 Desktop Mini
year:: ~2019
serial:: MXL0172Q6L
sku:: 9GB06UC#ABA
cpu:: Intel Core i5-9500T @ 2.20GHz (6c/6t)
ram:: 16 GB DDR4 SODIMM
gpu:: Intel UHD Graphics 630
storage:: 256 GB KIOXIA KXG60ZNV256G NVMe (root 91 GB, 71% used)
os:: NixOS 26.05 (Yarara)
firmware:: R21 Ver. 02.20.00 (2023-12-15)

- folly worker. Disko on `/dev/nvme0n1`.
- Newest x86 box in the fleet; the only folly node with an operational TPM: `tpm0` (version 2), `/dev/tpm0` and `/dev/tpmrm0` present, dmesg reports `tpm_tis IFX0785:00: 2.0 TPM (device-id 0x1B, rev-id 22)`. PCR-bank SHA256, 24 PCRs available.
