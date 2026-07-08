type:: host
role:: kiosk
vendor:: Raspberry Pi
model:: Raspberry Pi 4 Model B Rev 1.4 (8 GB)
year:: ~2020
serial:: 10000000cfbd3890
revision:: d03114
cpu:: BCM2711, Cortex-A72 (4c)
ram:: 8 GB
storage:: 32 GB microSD
os:: NixOS 26.05 (Yarara)

- Weather kiosk ([[Runbooks/Kiosk]]). Config: `nix/hosts/weatherpi4.nix`.
- Not on the LAN — reach it over the tailnet (`weatherpi4.pirate-musical.ts.net`).
- See [[Fleet]] for the full inventory.
