type:: host
cluster:: [[Architecture/Kubernetes]] folly
role:: worker
vendor:: HP
model:: EliteDesk 800 G2 DM 35W
year:: ~2016
serial:: MXL6372537
sku:: V0B22UP#ABA
cpu:: Intel Core i7-6700T @ 2.80GHz (4c/8t)
ram:: 16 GB DDR4 SODIMM
gpu:: Intel HD Graphics 530
storage:: 512 GB KingFast SATA SSD (root 98 GB, 39% used)
os:: NixOS 26.05 (Yarara)
firmware:: N21 Ver. 02.37 (2019-01-02)

- folly worker, node IP `10.3.0.11`. Disko on `/dev/sda`.
- Same physical box as the former `800g2`/`rosie` — third name for this machine; its `shale.lolwtf.ca` record replaced the `800g2` one in `terraform/network/unifi/folly/k8s.tf`.
- See [[Fleet]] for the full inventory.
