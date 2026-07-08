type:: host
cluster:: [[Architecture/Kubernetes]] folly
role:: worker
vendor:: HP
model:: EliteDesk 800 G2 DM 35W
year:: ~2016
serial:: MXL6372537
sku:: V0B22UP#ABA
cpu:: Intel Core i7-6700T @ 2.80GHz (4c/8t)
ram:: 16 GB
storage:: 512 GB KingFast SATA SSD
os:: NixOS 26.05 (Yarara)
firmware:: N21 Ver. 02.37 (2019-01-02)

- folly worker, node IP `10.3.0.11`. Disko on `/dev/sda`.
- No `shale.lolwtf.ca` DNS record as of 2026-07 — reach it via `ssh -J optiplex.lolwtf.ca jawn@10.3.0.11` (or fix the record).
- See [[Fleet]] for the full inventory.
