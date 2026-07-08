type:: host
cluster:: [[Architecture/Kubernetes]] folly
role:: control-plane
vendor:: Dell
model:: OptiPlex 3050 (micro)
year:: ~2017
serial:: 66BT7M2
sku:: 07A3
cpu:: Intel Core i7-7700T @ 2.90GHz (4c/8t)
ram:: 16 GB
storage:: 256 GB SK hynix SC311 SATA SSD
os:: NixOS 26.05 (Yarara)
firmware:: BIOS 1.27.0 (2023-09-19)

- folly control-plane node, node IP `10.3.0.10`. Config in `flake.nix` (`mkHost "optiplex"`); disko on `/dev/sda`.
- Reached as `optiplex.lolwtf.ca`; also the handy jump host for other folly nodes.
- See [[Fleet]] for the full inventory.
