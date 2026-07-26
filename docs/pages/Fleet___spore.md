type:: host
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

- NFS/PXE, signed native-boot, and standby DNS server — boot-critical for [[Fleet/forge]]'s first NVMe install (the legacy HTTP/RAM chain is kept as a fallback until forge is verified on NVMe); monitored by folly.
- NVMe-rooted. Config: `nix/hosts/spore.nix`.
- Reached as `spore.lolwtf.ca`.
- Redundant LAN NTP server paired with [[Fleet/capsule]] (`nix/services/ntp-server.nix`) and published with it as `time.lolwtf.ca`. Chrony uses authenticated NTS upstreams (`time.nrc.ca`, `time.chu.nrc.ca`), polls Capsule, and serves UDP/123 to routed `10.0.0.0/8` clients. Orphan fallback reports stratum 10; neither Pi is stratum 1 without a hardware reference clock.
- CoreDNS sinkhole using the shared `nix/services/coredns-sinkhole.nix` policy. It is not published through `dns.lolwtf.ca`.
- Verify with `chronyc tracking`, `chronyc sources -v`, and `chronyc authdata`.
- ## Netboot serving
	- There is no application, database, or dynamic boot decision — the Nix-built image is the policy. Spore serves files over HTTP (nginx) plus TFTP (dnsmasq); boot integrity is enforced by the EEPROM signature and the initrd's cmdline-pinned squashfs digest.
	- x86 k8s nodes netboot off the static iPXE tree in `/var/lib/tftpboot` (`nix/services/pxe-netboot.nix`): DHCP → TFTP `boot/ipxe.efi` → `menu.ipxe` → per-target kernel/initrd over HTTP.
	- `spore-native-boot-rackpi5.service` (`nix/services/spore-native-boot.nix`) is the legacy signed-RAM-image publisher for [[Fleet/forge]]: it signs `boot.img` with `/var/lib/pi-boot-sign/private.pem` and atomically publishes `boot.img`/`boot.sig`/`nix-store.squashfs` into `/var/lib/spore-native-boot/rackpi5`. nginx serves that directory at `/rackpi5-ram/`, matching the EEPROM's secondary `HTTP_PATH` (the EEPROM's primary boot is now NVMe).
	- A publisher failure doesn't affect the x86 static PXE tree; it just costs forge its last-resort fallback if the NVMe install ever breaks.
- ## Build and recovery
	- Validate without activating: `nix build .#nixosConfigurations.spore.config.system.build.toplevel --no-link` on a native aarch64 builder.
	- Before cutting over forge, verify the publisher unit is active, all three native artifacts return successfully, and the EEPROM contains the matching public key.
	- Roll back with `sudo nixos-rebuild switch --rollback`; rebuilding the older generation atomically republishes its matching signed rackpi5 artifacts.
