type:: host
vendor:: HP
model:: EliteDesk 800 G3 DM 35W
year:: ~2017
serial:: 8CG74769HJ
sku:: 1VR53UC#ABA
cpu:: Intel Core i5-6500 @ 3.20GHz (4c/4t)
ram:: 16 GB DDR4 SODIMM
gpu:: Intel HD Graphics 530
storage:: 512 GB KingFast SATA SSD (root 211 GB; the rest is `/mnt/disks`, where every offsite `local-path` volume lands)
os:: NixOS 26.05 (Yarara)
firmware:: P21 Ver. 02.15 (2018-01-31)

- offsite worker. Also runs docker, a GitHub Actions runner, and yarr.
- No TPM: `/sys/class/tpm/` is empty and there are no `/dev/tpm*` nodes. Reachable over the LAN at `10.89.0.11` (or via the tailnet).
