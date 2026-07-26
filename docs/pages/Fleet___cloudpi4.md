type:: host
vendor:: Raspberry Pi
model:: Raspberry Pi 4 Model B Rev 1.1 (4 GB)
year:: ~2019
serial:: 100000009c1080f8
revision:: c03111
cpu:: BCM2711, Cortex-A72 (4c)
ram:: 4 GB LPDDR4-3200
gpu:: Broadcom VideoCore VI
storage:: 64 GB microSD (root 59 GB, 41% used)
os:: NixOS 26.05 (Yarara)

- Utility Pi and CoreDNS canary. Config: `nix/hosts/cloudpi4.nix`, sharing the production sinkhole policy from `nix/services/coredns-sinkhole.nix`.
- Reached as `cloudpi4.lolwtf.ca`.
