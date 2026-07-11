type:: host
role:: radio
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
- **In the flake** as `nixosConfigurations.radiopi0` (`nix/hosts/radiopi0.nix` + `nix/hardware/pi0.nix`, shared with [[Hosts/blinkypi0]]). armv6l has no upstream binary cache and no board-support module (nixos-hardware/nixos-raspberrypi both bottom out at Pi 2 / Zero 2 W), so this cross-compiles from spore's aarch64 CPU via `nixpkgs.buildPlatform`/`hostPlatform` — no board module to lean on, no QEMU emulation, but the whole closure builds from source. Deliberately minimal: tailscale + ssh + wiringpi (GPIO tooling for the LED HATs) only, no chezmoi/ddnsd (mise also has no armv6l release, so it's dropped from the default user package set).
- `system.autoUpgrade` is disabled — there's no armv6l builder on the device itself, so generations are always built on spore and pushed via `nixos-rebuild --target-host`, never attempted on-device.
- **Not yet migrated**: still running Raspbian buster with `radio.service` (`/usr/local/bin/radio`, an HSV rainbow chase across the pHAT BEAT's two 7-pixel channels via `phatbeat.set_pixel`/`show` at 1 ms cadence) and the folly node-exporter scrape target (`clusters/folly/monitoring/...`; `instance: radiopi0` → `radiopi0.lolwtf.ca:9100`). Both need to be ported to the NixOS config before cutover. CloudEvents sibling lives at [[Hosts/blinkypi0]] (`ce-type: dev.pulsifer.radio.request`, also on `:3000`).
- See [[Fleet]] for the full inventory.
