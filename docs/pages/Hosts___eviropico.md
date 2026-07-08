type:: host
role:: enviro sensor
vendor:: Raspberry Pi
model:: Raspberry Pi Pico W / Pico 2 W
cpu:: RP2040 / RP2350 (MicroPython, not Linux)
ram:: 264 KB SRP6 / 8 MB flash
os:: Pimoroni MicroPython firmware
status:: unplugged
hat:: Pimoroni Enviro+ (BME688, LTR559, mic/SPL, TFT + optional particulate)

- A **Raspberry Pi Pico** (W or Pico 2 W), not a Pi proper — ran **MicroPython** flashed with [Pimoroni's pimoroni-pico / pimoroni-pico-rp2350](https://github.com/pimoroni/pimoroni-pico) firmware, driving a Pimoroni **Enviro+** board (BME688 gas/temp/hum/press, LTR559 light, an SPL/graphic-equalizer mic FFT, and a 240×240 `DISPLAY_ENVIRO_PLUS` TFT).
- **Unplugged, not retired — still here and working well** when powered and re-chained over USB. Never in the flake (MicroPython on a microcontroller, nothing to declaratively manage); flashed via Thonny, shared into WSL with [usbipd-win](https://github.com/dorssel/usbipd-win). The `systems/rpi/eviropico/` dir (`default.nix` shell + 315-line `main.py`) was cleared in the `df20515b` graveyard cleanup; everything below is from that history.
- `main.py` read all Enviro+ sensors (BME688 via `breakout_bme68x`, LTR559 light, `ADCFFT` mic graphic equaliser), rendered to the TFT, and lit the onboard RGBLED red when the gas resistance dropped below 50%. Buttons A/B toggled backlight; X/Y switched between sensor readout and graphic-equaliser modes.
- See [[Fleet]] for the full inventory.