type:: host
role:: NFS / PXE boot server
vendor:: Raspberry Pi
model:: Raspberry Pi 5 Model B Rev 1.1 (8 GB)
year:: ~2023
serial:: d860ec5f943fe335
revision:: d04171
cpu:: BCM2712, Cortex-A76 (4c)
ram:: 8 GB LPDDR4X-4267
gpu:: Broadcom VideoCore VII
storage:: 128 GB Patriot P300 NVMe (root 32 GB, 35% used)
os:: NixOS 26.05 (Yarara)

- NFS/PXE and signed native-boot server — **boot-critical for [[Hosts/rackpi5]]** ([[ADR/0008 Diskless netboot for rackpi5]]); monitored by folly.
- Only Pi with NVMe storage (128 GB Patriot P300). Config: `nix/hosts/spore.nix`.
- Reached as `spore.lolwtf.ca`.
- Redundant LAN NTP server paired with [[Hosts/dns]] (`nix/services/ntp-server.nix`). Chrony uses authenticated Cloudflare and Netnod NTS upstreams, polls DNS, and serves UDP/123 to routed `10.0.0.0/8` clients. Orphan fallback reports stratum 10; neither Pi is stratum 1 without a hardware reference clock.
- Verify with `chronyc tracking`, `chronyc sources -v`, and `chronyc authdata`.
- ## Netboot serving
	- There is **no application, database, or dynamic boot decision** — the Nix-built image is the policy. Spore just serves files over HTTP (nginx) plus TFTP (dnsmasq). The old Next.js catalog/observation app was removed; boot integrity is enforced by the EEPROM signature and the initrd's cmdline-pinned squashfs digest, not by a server.
	- **x86 k8s nodes** netboot off the static iPXE tree in `/var/lib/tftpboot` (`nix/services/pxe-netboot.nix`): DHCP → TFTP `boot/ipxe.efi` → `menu.ipxe` → per-target kernel/initrd over HTTP.
	- **rackpi5** HTTP-boots the signed RAM image. `spore-native-boot-rackpi5.service` (`nix/services/spore-native-boot.nix`) runs as root, signs `boot.img` with `/var/lib/pi-boot-sign/private.pem`, and atomically publishes `boot.img`/`boot.sig`/`nix-store.squashfs` into a world-traversable release dir under `/var/lib/spore-native-boot/rackpi5`. nginx serves that directory verbatim at `/rackpi5-ram/` (matching the EEPROM's `HTTP_PATH`).
	- A publisher failure does not affect the separate x86 static PXE tree, but it takes out rackpi5's sole boot path.
- ## Build and recovery
	- Validate without activating: `nix build .#nixosConfigurations.spore.config.system.build.toplevel --no-link` on a native aarch64 builder.
	- Deploy from merged Git with the standard NixOS host workflow. Before cutting over rackpi5, verify the publisher unit is active, all three native artifacts return successfully, and the EEPROM contains the matching public key.
	- Roll back Spore with `sudo nixos-rebuild switch --rollback`; rebuilding the older generation atomically republishes its matching signed rackpi5 artifacts.
- See [[Fleet]] for the full inventory.
