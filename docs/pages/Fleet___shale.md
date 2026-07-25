type:: host
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

- folly worker. Disko on `/dev/sda`.
- TPM 1.2 enumerated: `tpm0` (version 1), `/dev/tpm0` present, dmesg reports `tpm_tis 00:01: 1.2 TPM (device-id 0x1B, rev-id 16)`. No SHA256 PCR bank (TPM 1.2). Too old for `systemd-cryptenroll`/TPM-backed disk encryption, which need TPM 2.0.
