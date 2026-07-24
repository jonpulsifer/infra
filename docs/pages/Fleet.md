icon:: 🖥️

- Every host in the homelab. Each has a page under `Fleet/` carrying its hardware sheet — vendor, model, serial, CPU, RAM, storage, firmware — and its physical quirks.
- Roles, cluster membership, and node addresses are **not** recorded here. Hosts are declared in `flake.nix`; network facts live in the topology SSOT described on [[Architecture/Kubernetes]]. Read those.
- ## Kubernetes nodes
	- Declared inline in `flake.nix`. See [[Architecture/Kubernetes]] for cluster composition.
	- | Host | Cluster | Hardware |
	  | ---- | ------- | -------- |
	  | [[Fleet/optiplex]] | folly | Dell OptiPlex 3050 micro, i7-7700T |
	  | [[Fleet/riptide]] | folly | HP EliteDesk 800 G5 DM, i5-9500T |
	  | [[Fleet/shale]] | folly | HP EliteDesk 800 G2 DM 35W, i7-6700T |
	  | [[Fleet/retrofit]] | offsite | HP EliteDesk 800 G2 DM 65W, i7-6700T |
	  | [[Fleet/oldschool]] | offsite | HP EliteDesk 800 G3 DM 35W, i5-6500 |
- ## Raspberry Pis
	- Configured in `nix/hosts/`. See [[Architecture/NixOS]] for how they build.
	- | Host | Purpose | Hardware |
	  | ---- | ------- | -------- |
	  | [[Fleet/spore]] | NFS, PXE and signed native-boot server | Pi 5 8 GB, NVMe |
	  | [[Fleet/dns]] | LAN DNS and NTP | Pi 5 8 GB |
	  | [[Fleet/rackpi5]] | rack status display | Pi 5 8 GB, diskless |
	  | [[Fleet/homepi4]] | kiosk | Pi 4B 8 GB, 7" touch display |
	  | [[Fleet/weatherpi4]] | weather kiosk | Pi 4B 8 GB |
	  | [[Fleet/cloudpi4]] | utility | Pi 4B 4 GB |
	  | [[Fleet/radiopi0]] | radio | Pi Zero W |
	  | [[Fleet/blinkypi0]] | LED display | Pi Zero W |
- ## Microcontroller
	- | Host | Purpose | Hardware |
	  | ---- | ------- | -------- |
	  | [[Fleet/eviropico]] | environment sensor | Pi Pico W, Pimoroni Enviro+ |
- ## Cloud
	- | Host | Where | Hardware |
	  | ---- | ----- | -------- |
	  | [[Fleet/oldboy]] | GCE, `homelab-ng` project | e2-micro, free tier |
- ## Reaching hosts
	- LAN hosts resolve as `<host>.lolwtf.ca`.
	- [[Fleet/weatherpi4]] and the offsite nodes require the tailnet.
	- Kubernetes nodes have Tailscale disabled — reach them over the LAN or through the cluster.
- ## Known divergence
	- Git is the source of truth for this fleet; these hosts differ from what the repo declares, and each difference is a bug to close.
	- [[Fleet/cloudpi4]] runs Ubuntu. Its NixOS config exists and is unapplied.
	- [[Fleet/radiopi0]] runs Raspbian. Its NixOS config carries no radio service; the armv6l closure builds but the service is not ported.
	- [[Fleet/blinkypi0]] is unplugged. Its NixOS config carries no device service and its device code is not in git.
	- [[Fleet/eviropico]] is unplugged. Its MicroPython code is not in git.
