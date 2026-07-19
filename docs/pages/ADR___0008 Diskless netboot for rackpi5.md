status:: accepted
date:: 2026-07-07 (backfilled 2026-07-08)
deciders:: [[jawn]]
tags:: adr

- # Context
	- SD cards are the least reliable component in the Pi fleet, and `rackpi5` sits in the rack where card swaps are annoying. `spore` already owns network boot policy and serving for the lab.
	- An ARM64 UEFI/iPXE chain was evaluated, but the archived Pi 5 EDK2 firmware does not support the built-in RP1 Ethernet controller, and current U-Boot likewise has no RP1 Ethernet driver. Requiring a USB NIC and abandoned firmware would make the boot path less safe, not more modern.
- # Decision
	- `rackpi5` runs **diskless** with one boot path. Its Pi EEPROM HTTP-loads `boot.sig` and `boot.img` from Spore's native-boot API; there is no NFS-root, TFTP, SD, or UEFI fallback tier.
	- `nix/hosts/rackpi5.nix` is the sole host and image configuration. Its image build embeds the matching squashfs SHA-256 in `cmdline.txt`; Spore atomically publishes and signs that exact first-stage image with a private key that never enters the Nix store.
	- The EEPROM verifies `boot.img`; the signed command line anchors the squashfs digest; stage 1 refuses to mount a downloaded store that does not match it.
- # Consequences
	- No local storage or alternate boot state can drift. A reboot either runs the Git/Nix-reviewed generation published by Spore or fails closed.
	- `spore.service`, its root-only native artifact publisher, and nginx are boot-critical for rackpi5 and must be deployed before the EEPROM cutover.
	- All rackpi5 state is ephemeral by design; anything worth keeping must live elsewhere.
	- Gotcha class to watch: DHCP/netboot identity mixups (a MAC swap between `dns` and `rackpi5` has bitten before).
- # Links
	- [[Architecture/NixOS]], [[Fleet]]
