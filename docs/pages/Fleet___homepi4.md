type:: host
vendor:: Raspberry Pi
model:: Raspberry Pi 4 Model B Rev 1.4 (8 GB)
hat:: Raspberry Pi 7" Touch Display
case:: SmartiPi Touch 2
year:: ~2020
serial:: 100000001e657842
revision:: d03114
cpu:: BCM2711, Cortex-A72 (4c)
ram:: 8 GB LPDDR4-3200
gpu:: Broadcom VideoCore VI
storage:: 32 GB microSD (root 29 GB, 72% used)
os:: NixOS 26.05 (Yarara)

- Kiosk Pi in a [SmartiPi Touch 2](https://smarticase.com/collections/smartipi-touch-2/products/smartipi-touch-2) case with the [Raspberry Pi 7" Touch Display](https://www.buyapi.ca/product/smartipi-touch-2-case-for-7-official-display/) — a physical twin of [[Fleet/weatherpi4]] (same Pi 4B 8 GB, same `pi4 + common + iperf3 + kiosk` NixOS modules; only Wi-Fi SSIDs differ). See [[Runbooks/Kiosk]].
- Config: `nix/hosts/homepi4.nix`.
- The wired `homepi4.lolwtf.ca` record can be unreachable; `homepi4-wifi.lolwtf.ca` works.
