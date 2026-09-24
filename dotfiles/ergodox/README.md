# ErgoDox EZ firmware

The Pandemic keymap for a ZSA ErgoDox EZ, exported from ZSA's Oryx configurator. The QMK keymap source is in `pandemic/`, and the compiled firmware file sits beside it with its MD5 checksum.

## Flash

Check the firmware file against its checksum. The two hashes must match.

```bash
md5sum ergodox_ez_pandemic_Azxpx_rOwD6.hex
cat ergodox_ez_pandemic_Azxpx_rOwD6.md5
```

Flash the `.hex` file with ZSA's Keymapp app.

## Build

The `Dockerfile` compiles `pandemic/` for the Shine variant against `zsa/qmk_firmware`, and it does not build as written. It copies the keymap files into `keyboards/ergodox_ez/keymaps/` with no `pandemic/` directory, and the fork keeps the keyboard under `keyboards/zsa/ergodox_ez/`. Fix both paths before you build from it.
