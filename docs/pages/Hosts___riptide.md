type:: host
cluster:: [[Architecture/Kubernetes]] folly
role:: worker
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

- folly worker, node IP `10.3.0.12`. Disko on `/dev/nvme0n1`.
- Newest x86 box in the fleet; has a working TPM 2.0 ([[Runbooks/TPM Audit]]).
- See [[Fleet]] for the full inventory.
