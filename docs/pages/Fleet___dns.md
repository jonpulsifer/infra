type:: host
vendor:: Raspberry Pi
model:: Raspberry Pi 5 Model B Rev 1.1 (8 GB)
year:: ~2023
serial:: d9c81ac9b4823886
revision:: d04171
cpu:: BCM2712, Cortex-A76 (4c)
ram:: 8 GB LPDDR4X-4267
gpu:: Broadcom VideoCore VII
storage:: 32 GB microSD (root 27 GB, 13% used)
os:: NixOS 26.05 (Yarara)

- LAN DNS server. Config: `nix/hosts/dns.nix`.
- Redundant LAN NTP server paired with [[Fleet/spore]] (`nix/services/ntp-server.nix`). Chrony uses authenticated NTS upstreams (`time.nrc.ca`, `time.chu.nrc.ca`), polls Spore, and serves UDP/123 to routed `10.0.0.0/8` clients. If all upstream time disappears, orphan mode elects one Pi to preserve a common timebase at stratum 10.
- Verify with `chronyc tracking`, `chronyc sources -v`, and `chronyc authdata`.
- Reached as `dns.lolwtf.ca`.
