type:: host
vendor:: Raspberry Pi
model:: Raspberry Pi 5 Model B Rev 1.1 (8 GB)
year:: ~2023
serial:: d860ec5f943fe335
revision:: d04171
cpu:: BCM2712, Cortex-A76 (4c)
ram:: 8 GB LPDDR4X-4267
gpu:: Broadcom VideoCore VII
storage:: 128 GB Patriot P300 NVMe (root capped at 32 GB; remaining space mounted at /nfs/data)
os:: NixOS 26.05 (Yarara)

- NFS/PXE, signed native-boot, and production DNS server. The HTTP/RAM chain is [[Fleet/forge]]'s EEPROM fallback; folly monitors each service.
- NVMe-rooted. Config: `nix/hosts/spore.nix`.
- Reached as `spore.lolwtf.ca`.
- Redundant LAN NTP server paired with [[Fleet/capsule]] (`nix/services/ntp-server.nix`) and published with it as `time.lolwtf.ca`. Chrony uses authenticated NTS upstreams (`time.nrc.ca`, `time.chu.nrc.ca`), polls Capsule, and serves UDP/123 to routed `10.0.0.0/8` clients. Orphan fallback reports stratum 10; neither Pi is stratum 1 without a hardware reference clock.
- CoreDNS sinkhole using the shared `nix/services/coredns-sinkhole.nix` policy. `dns.lolwtf.ca` publishes spore with [[Fleet/capsule]] as the resolver pair.
- Verify with `chronyc tracking`, `chronyc sources -v`, and `chronyc authdata`.
- ## Netboot serving
	- There is no application, database, or dynamic boot decision — the Nix-built image is the policy. Spore serves files over HTTP (nginx) plus TFTP (dnsmasq); boot integrity is enforced by the EEPROM signature and the initrd's cmdline-pinned squashfs digest.
	- x86 k8s nodes netboot off the static iPXE tree in `/var/lib/tftpboot` (`nix/services/pxe-netboot.nix`): DHCP → TFTP `boot/ipxe.efi` → `menu.ipxe` → per-target kernel/initrd over HTTP.
	- `spore-native-boot-rackpi5.service` (`nix/services/spore-native-boot.nix`) is the signed-RAM-image publisher for [[Fleet/forge]]. It signs `boot.img` with `/var/lib/pi-boot-sign/private.pem`, atomically switches the stable `boot.img`/`boot.sig` pair under `/rackpi5-ram/`, and publishes each squashfs as `/<sha256>.squashfs`. The signed initrd requests its pinned digest, so an activation cannot mix boot and root generations.
	- The local artifact timer probes the current image, signature, and digest-addressed squashfs over nginx and exports `spore_native_boot_artifact_available` through node-exporter's textfile collector. A publisher failure doesn't prevent nginx from serving the independent x86 PXE tree; it costs forge its last-resort fallback.
- ## Build and recovery
	- Validate without activating: `nix build .#nixosConfigurations.spore.config.system.build.toplevel --no-link` on a native aarch64 builder.
	- Before changing forge's boot path, verify the publisher and artifact-check units, confirm the three `spore_native_boot_artifact_available` series are `1`, and confirm the EEPROM contains the matching public key.
	- Roll back with `sudo nixos-rebuild switch --rollback`; the selected generation republishes its matching signed rackpi5 artifacts.
