type:: host
vendor:: Raspberry Pi
model:: Raspberry Pi Zero W Rev 1.1
hat:: Pimoroni pHAT BEAT (mono 2×7 VU LED + audio DAC)
case:: Pimoroni Pirate Radio case
year:: ~2017
serial:: 0000000056f8a6ff
revision:: 9000c1
cpu:: BCM2835, ARM1176 (1c, armv6l)
ram:: 512 MB LPDDR2 (package-on-package)
gpu:: Broadcom VideoCore IV
storage:: 32 GB microSD (root 30 GB, 8% used)
os:: Raspbian 10 (buster)

- Pi Zero W radio box in a Pimoroni [Pirate Radio](https://shop.pimoroni.com/products/pirate-radio-pi-zero-w-project-kit) case with a [pHAT BEAT](https://shop.pimoroni.com/products/phat-beat) DAC + mono VU LED bar.
- Runs Raspbian. The radio service (an HSV rainbow chase across the pHAT BEAT's two 7-pixel channels) is on-device and not in git. It is also the folly node-exporter scrape target (`clusters/folly/monitoring/local-node-exporters.yaml`, `radiopi0.lolwtf.ca:9100`).
- In the flake as `nixosConfigurations.radiopi0` (`nix/hosts/radiopi0.nix` + `nix/hardware/pi0.nix`, shared with [[Fleet/blinkypi0]]). armv6l has no upstream binary cache and no board-support module, so this cross-compiles from spore's aarch64 CPU — see [[Architecture/NixOS]]. Config is minimal: tailscale + ssh + wiringpi only.
- `system.autoUpgrade` is disabled: there's no armv6l builder on-device, so generations are always built on spore and pushed with `nixos-rebuild --target-host`.
