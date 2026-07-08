status:: accepted
date:: 2026 (backfilled 2026-07-08)
deciders:: [[jawn]]
tags:: adr

- # Context
	- Host disk layouts were hand-partitioned and inconsistent; reinstalls were artisanal. Declarative partitioning needed a stable way for the bootloader and fstab to find partitions across device-name changes (`/dev/sda` vs `/dev/nvme0n1`).
- # Decision
	- Use **disko** for declarative partitioning on the x86 hosts, with mounts keyed on **GPT partlabels** (`disk-main-*`). Each host declares only its target device (`homelab.disko.device` in `flake.nix`).
- # Consequences
	- Installs and reinstalls are reproducible from the flake; device naming no longer matters.
	- Hosts labeled before the disko change fail to boot on a new generation unless relabeled to `disk-main-*`; relabel scripts live in `nix/scripts/`.
	- Rollback on an unmigrated host is the bootloader's previous-generation menu.
- # Links
	- [[Architecture/NixOS]], [[Fleet]]
