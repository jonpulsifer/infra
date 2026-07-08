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

- Pi Zero W radio box in a Pimoroni [Pirate Radio](https://shop.pimoroni.com/products/pirate-radio-pi-zero-w-project-kit) case with a [pHAT BEAT](https://shop.pimoroni.com/products/phat-beat) DAC + mono VU LED bar. **Unmanaged**: not in `flake.nix`, runs EOL Raspbian buster, login is `pi@radiopi0.lolwtf.ca`.
- `radio.service` runs `/usr/local/bin/radio`, an HSV rainbow chase across the pHAT BEAT's two 7-pixel channels (`phatbeat.set_pixel`/`show` at 1 ms cadence). Its CloudEvents sibling lives at [[Hosts/blinkypi0]] (`ce-type: dev.pulsifer.radio.request`, also on `:3000`).
- Scrape target for folly's node-exporter job (`clusters/folly/monitoring/...`; `instance: radiopi0` → `radiopi0.lolwtf.ca:9100`).
- Candidate for adoption into the flake (armv6l makes NixOS awkward — cross-compiled or stay Raspbian).
- See [[Fleet]] for the full inventory.
