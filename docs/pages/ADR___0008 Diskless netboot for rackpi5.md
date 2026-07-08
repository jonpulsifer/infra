status:: accepted
date:: 2026-07-07 (backfilled 2026-07-08)
deciders:: [[jawn]]
tags:: adr

- # Context
	- SD cards are the least reliable component in the Pi fleet, and `rackpi5` sits in the rack where card swaps are annoying. `spore` already serves NFS/PXE for the lab.
- # Decision
	- `rackpi5` runs **diskless**. Its default boot is a **stateless RAM image** built from the flake (`nix/images/pi5-ram.nix`, the `rackpi5-ram` configuration) and served over HTTP from `spore`; the NFS-root `rackpi5` configuration is the fallback tier.
- # Consequences
	- No local storage to fail; a reboot always boots a known-good image, and "deploying" means publishing a new image on spore.
	- `spore` becomes boot-critical infrastructure — its NFS/PXE stack is scraped and alerted on by the folly monitoring stack.
	- All rackpi5 state is ephemeral by design; anything worth keeping must live elsewhere.
	- Gotcha class to watch: DHCP/netboot identity mixups (a MAC swap between `dns` and `rackpi5` has bitten before).
- # Links
	- [[Architecture/NixOS]], [[Fleet]]
