type:: host
role:: radio
vendor:: Raspberry Pi
model:: Raspberry Pi Zero W Rev 1.1
year:: ~2017
serial:: 0000000056f8a6ff
revision:: 9000c1
cpu:: BCM2835, ARM1176 (1c, armv6l)
ram:: 512 MB LPDDR2 (package-on-package)
gpu:: Broadcom VideoCore IV
storage:: 32 GB microSD (root 30 GB, 8% used)
os:: Raspbian 10 (buster)

- Pi Zero W radio box. **Unmanaged**: not in `flake.nix`, runs EOL Raspbian buster, login is `pi@radiopi0.lolwtf.ca`.
- Candidate for adoption into the flake (armv6l makes NixOS awkward — cross-compiled or stay Raspbian).
- See [[Fleet]] for the full inventory.
