type:: host
vendor:: Raspberry Pi
model:: Raspberry Pi 5 Model B Rev 1.1 (8 GB)
year:: ~2023
serial:: aed421e548c12e74
revision:: d04171
cpu:: BCM2712, Cortex-A76 (4c)
ram:: 8 GB LPDDR4X-4267
gpu:: Broadcom VideoCore VII
storage:: 256 GB Patriot P300 NVMe (root, sd-image flash)
os:: NixOS 26.05 (Yarara), NVMe image

- The lab's native arm64 build host. Boots off its installed NVMe and runs `services.buildHost` (`nix/services/build-host.nix`) — Nix remote builder (`nix.distributedBuilds`), docker + buildx for native arm64 OCI image builds, and a harmonia binary cache fronted by nginx on `forge.lolwtf.ca:80`.
- NVMe-rooted. Config: `nix/hosts/forge.nix`. Standard sd-image single-partition layout (`sdImage.expandOnBoot = true`); the NVMe is dedicated to root, unlike spore's `grow-root-and-partition-storage` service which reserves the disk tail for `/nfs/data`.
- The spore-side signed-RAM-image publisher for [[Fleet/spore]] (the legacy `spore-native-boot-rackpi5.service`) is the fallback for forge's first NVMe install — see [[Fleet/spore]] for the publisher details and [[Architecture/NixOS]] for the conversion plan.
- First install is a live install over the running RAM image: build the forge `sdImage` on spore (`nix build .#packages.x86_64-linux.forge`), `dd` the result to `/dev/nvme0n1` on the box, set EEPROM `BOOT_ORDER=0xf416` (NVMe first, HTTP second) by hand, reboot. The HTTP second entry means a failed NVMe install falls back to the spore-published signed image rather than bricking.
- The EEPROM's own boot-order configuration lives outside the Nix closure and is applied by hand with `rpi-eeprom-config --edit` — a stock EEPROM firmware update erases the enrolled signing key for the legacy HTTP path, so it needs re-enrolling before the next reboot after any such update.
- harmonia's signing key is decrypted from `nix/secrets/forge.sops.yaml`; the public half is committed in the clear at `nix/secrets/forge-harmonia-cache.pub` and is what clients pin in `nix.settings.trusted-public-keys`. Cache URL once clients opt in: `http://forge.lolwtf.ca`.
