type:: host
vendor:: Raspberry Pi
model:: Raspberry Pi Pico W / Pico 2 W
cpu:: RP2040 / RP2350 (MicroPython, not Linux)
ram:: 264 KB SRAM / 8 MB flash
os:: Pimoroni MicroPython firmware
status:: unplugged
hat:: Pimoroni Enviro+ (BME688, LTR559, mic/SPL, TFT + optional particulate)

- A Raspberry Pi Pico (W or Pico 2 W), not a Pi proper — runs MicroPython flashed with [Pimoroni's pimoroni-pico firmware](https://github.com/pimoroni/pimoroni-pico), driving a Pimoroni Enviro+ board (BME688 gas/temp/hum/press, LTR559 light, an SPL/graphic-equalizer mic FFT, and a 240×240 TFT).
- Reads the Enviro+ sensors, renders to the TFT, and lights the onboard RGB LED red when gas resistance drops below 50%. Buttons A/B toggle the backlight; X/Y switch between sensor readout and graphic-equalizer modes.
- Unplugged. Never in the flake — MicroPython on a microcontroller, nothing to declaratively manage. Flashed via Thonny, shared into WSL with [usbipd-win](https://github.com/dorssel/usbipd-win). Its code is not in git.
