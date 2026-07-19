icon:: 🖥️

- Every physical (and one virtual) host, from `flake.nix`. Each has a dedicated page under [[Hosts]] with serials, hardware, and quirks (surveyed live 2026-07-08); deploy mechanics in [[Architecture/NixOS]].
- ## folly — primary k8s cluster
	- | Host | Role | Hardware | Notes |
	  | ---- | ---- | -------- | ----- |
	  | [[Hosts/optiplex]] | control-plane | Dell OptiPlex 3050, i7-7700T | disko on `/dev/sda` |
	  | [[Hosts/riptide]] | worker | HP EliteDesk 800 G5 Mini, i5-9500T | NVMe, working TPM 2.0 |
	  | [[Hosts/shale]] | worker | HP EliteDesk 800 G2 DM 35W, i7-6700T | ex-`800g2`/`rosie` — same box, third name |
- ## offsite — backup k8s cluster
	- | Host | Role | Hardware | Notes |
	  | ---- | ---- | -------- | ----- |
	  | [[Hosts/retrofit]] | control-plane | HP EliteDesk 800 G2 DM 65W, i7-6700T | |
	  | [[Hosts/oldschool]] | worker | HP EliteDesk 800 G3 DM 35W, i5-6500 | also: docker, GitHub runner, yarr |
- ## Raspberry Pis
	- | Host | Purpose | Hardware | Notes |
	  | ---- | ------- | -------- | ----- |
	  | [[Hosts/cloudpi4]] | utility Pi | Pi 4B 4 GB | still Ubuntu 22.04, not NixOS |
	  | [[Hosts/homepi4]] | kiosk | Pi 4B 8 GB | [[Runbooks/Kiosk]]; use `homepi4-wifi.lolwtf.ca` |
	  | [[Hosts/weatherpi4]] | kiosk | Pi 4B 8 GB | reach over Tailscale; [[Runbooks/Kiosk]] |
	  | [[Hosts/dns]] | DNS | Pi 5 8 GB | |
	  | [[Hosts/rackpi5]] | rack status | Pi 5 8 GB | **diskless** — RAM image from spore ([[ADR/0008 Diskless netboot for rackpi5]]) |
	  | [[Hosts/spore]] | NFS/PXE boot server | Pi 5 8 GB, NVMe | boot-critical for rackpi5; monitored by folly |
	  | [[Hosts/radiopi0]] | radio | Pi Zero W | **unmanaged** — Raspbian buster, Pirate Radio case + pHAT BEAT DAC |
- ## Offline / unplugged Pis
	- | Host | Purpose | Hardware | Notes |
	  | ---- | ------- | -------- | ----- |
	  | [[Hosts/blinkypi0]] | blinky + CloudEvents | Pi Zero W | offline — Blinkt! in a Flirc case; not in the flake |
	  | [[Hosts/eviropico]] | enviro sensor | Pico W / Pico 2 W | unplugged but working — Enviro+ MicroPython, not in the flake |
- ## Cloud
	- | Host | Where | Notes |
	  | ---- | ----- | ----- |
	  | [[Hosts/oldboy]] | GCE e2-micro (free tier) | tagged `gcp` |
- ## Images (not hosts)
	- `wsl`, `iso`, `gce`, `container`, and `netboot` are standalone buildable images. `rackpi5` directly exposes its signed-boot input as `config.system.build.piBootImg`.
- ## Reaching things
	- LAN hosts resolve as `<host>.lolwtf.ca`; offsite and weatherpi4 require the tailnet. k8s nodes have Tailscale disabled — go through the LAN or the cluster.
