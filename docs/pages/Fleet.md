icon:: 🖥️

- Every physical (and one virtual) host, from `flake.nix`. Hardware details from the [[Runbooks/TPM Audit]]; deploy mechanics in [[Architecture/NixOS]].
- ## folly — primary k8s cluster
	- | Host | Role | Hardware | Notes |
	  | ---- | ---- | -------- | ----- |
	  | optiplex | control-plane | Dell OptiPlex 3050 | disko on `/dev/sda` |
	  | riptide | worker | HP EliteDesk 800 G5 Mini | disko on `/dev/nvme0n1`, working TPM 2.0 |
	  | shale | worker | HP EliteDesk 800 G2 DM 35W | disko on `/dev/sda` |
- ## offsite — backup k8s cluster
	- | Host | Role | Hardware | Notes |
	  | ---- | ---- | -------- | ----- |
	  | retrofit | control-plane | HP EliteDesk 800 G2 DM 65W | |
	  | oldschool | worker | HP EliteDesk 800 G3 DM 35W | also: docker, GitHub runner, yarr |
- ## Raspberry Pis
	- | Host | Purpose | Notes |
	  | ---- | ------- | ----- |
	  | cloudpi4 | utility Pi | |
	  | homepi4 | kiosk | [[Runbooks/Kiosk]] |
	  | weatherpi4 | kiosk | reach over Tailscale; [[Runbooks/Kiosk]] |
	  | dns | DNS | |
	  | rackpi5 | rack status | **diskless** — boots a RAM image from spore ([[ADR/0008 Diskless netboot for rackpi5]]) |
	  | spore | NFS/PXE boot server | boot-critical for rackpi5; monitored by folly |
- ## Cloud
	- | Host | Where | Notes |
	  | ---- | ----- | ----- |
	  | oldboy | GCE | tagged `gcp` |
- ## Images (not hosts)
	- `wsl`, `iso`, `gce`, `container`, `netboot`, and `rackpi5-ram` (the pi5 RAM image) are buildable images defined alongside the hosts in `flake.nix`.
- ## Reaching things
	- LAN hosts resolve as `<host>.lolwtf.ca`; offsite requires the tailnet. k8s nodes have Tailscale disabled — go through the LAN or the cluster.
