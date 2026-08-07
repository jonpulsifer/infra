type:: host
vendor:: Dell
model:: OptiPlex 3050 (micro)
year:: ~2017
serial:: 66BT7M2
sku:: 07A3
cpu:: Intel Core i7-7700T @ 2.90GHz (4c/8t)
ram:: 16 GB DDR4 SODIMM
gpu:: Intel HD Graphics 630 (8086:5912)
storage:: 256 GB SK hynix SC311 SATA SSD (root 91 GB, 79% used)
os:: NixOS 26.05 (Yarara)
firmware:: BIOS 1.27.0 (2023-09-19)

- folly control-plane node. Declared in `nix/hosts/`; disko on `/dev/sda`.
- TPM not enumerated: `/sys/class/tpm/` is empty and there are no `/dev/tpm*` nodes. ACPI advertises a TPM2 table (DELL CBX3); Intel PTT firmware-level TPM exists but the kernel driver does not claim it. Needs BIOS enablement of "Intel Platform Trust Technology" / "TPM 2.0" then a reboot before `systemd.tpm2.enable` is useful here.
- Reached as `optiplex.lolwtf.ca`; also the jump host for other folly nodes.
