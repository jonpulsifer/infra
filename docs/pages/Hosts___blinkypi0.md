type:: host
role:: blinky LED + CloudEvents
vendor:: Raspberry Pi
model:: Raspberry Pi Zero W
year:: ~2017
cpu:: BCM2835, ARM1176 (armv6l)
ram:: 512 MB LPDDR2
gpu:: Broadcom VideoCore IV
os:: Raspberry Pi OS Lite (historical)
status:: offline
hat:: Pimoroni Blinkt! (8-pixel APA102 LED strip)
case:: Flirc Raspberry Pi Zero Case

- Pi Zero W with a [Blinkt!](https://github.com/pimoroni/blinkt) LED board in the [Flirc Raspberry Pi Zero Case](https://flirc.tv/more/flirc-raspberry-pi-zero-case) — the source of every `flirc` reference in the repo.
- **Offline** (not retired — the hardware's still here, just unplugged), but **in the flake** as `nixosConfigurations.blinkypi0` (`nix/hosts/blinkypi0.nix`, sharing `nix/hardware/pi0.nix` with [[Hosts/radiopi0]] — same armv6l cross-compile story, no board-support module or binary cache upstream). Unlike radiopi0, this config is derived from this page's history rather than verified against live hardware, since the device is unplugged — expect to double-check wifi/hardware specifics against the real Pi once it's powered back on. Minimal config: tailscale + ssh + wiringpi only, no mise-dotfiles/ddnsd; mise dropped from the default user packages (no armv6l release). The `systems/rpi/blinkypi0/` provisioning artifacts lived in git until the `df20515b` graveyard cleanup; everything below is from that history.
- **Not yet ported**: `cloudevents.service` and `blinky.service` (below) still only exist from the pre-cleanup history, not in the NixOS config. Needs doing before this can actually replace the Raspberry Pi OS install.
- `cloudevents.service` runs a Flask + [cloudevents-python](https://github.com/cloudevents/sdk-python) server on `:3000` that turns incoming CloudEvents into Blinkt! animations, supporting `blink`, `brighten`, `clear`, `darken`, `rainbow`, `status`:
	- ```sh
	  curl -X POST \
	      -H "content-type: application/json" \
	      -H "ce-specversion: 1.0" \
	      -H "ce-source: https://github.com/jonpulsifer/cloudlab/rpi/blinkypi0" \
	      -H "ce-type: dev.pulsifer.blinky.request" \
	      -H "ce-id: lolpotato-123" \
	      -d '{"action":"rainbow"}' \
	      http://blinkypi0:3000
	  ```
- `blinky.service` runs `/usr/local/bin/blinky` — an 8-pixel random-colour randomizer over the [Blinkt!](https://github.com/pimoroni/blinkt) python library (`blinkt.set_pixel`/`show` at 0.05 s cadence, brightness 0.1).
- Same CloudEvents pattern as its sibling [[Hosts/radiopi0]].
- See [[Fleet]] for the full inventory.