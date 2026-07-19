icon:: ❄️
tags:: architecture

- **Layer 1.** Every physical host runs NixOS, configured under `nix/` and declared in `flake.nix` via a `mkHost` helper (`nix/lib/mkHost.nix`). See [[Fleet]] for the concrete machines.
- ## Layout
	- `nix/hosts/<hostname>.nix` — per-host entry points (the Pis, `spore`, `oldboy`); k8s nodes are defined directly in `flake.nix` with `role`/`tags` and pull in the k8s service modules
	- `nix/hardware/` — hardware profiles (pi4, pi5, x86)
	- `nix/services/` — optional service modules (`k8s/`, `common.nix`, `kiosk.nix`, `iperf3.nix`, …)
	- `nix/system/` — core modules: SSH hardening, Tailscale, auto-upgrades, users, disko, mise-dotfiles
	- `nix/overlays/` — package patches and overrides
	- `nix/images/` — buildable images: WSL tarball, ISO, GCE, container, netboot, and the pi5 RAM image
	- App-local `package.nix` / `module.nix` pairs may be imported by a host when an application belongs directly on NixOS. `apps/spore` uses this pattern for its pinned Node package, migrations, generated boot catalog, systemd lifecycle, and nginx routes.
- ## Host groups
	- **folly k8s nodes**: `optiplex` (control-plane), `riptide`, `shale`
	- **offsite k8s nodes**: `retrofit` (control-plane), `oldschool`
	- **Raspberry Pis**: `cloudpi4`, `homepi4`, `weatherpi4`, `dns`, `rackpi5` (diskless — see [[ADR/0008 Diskless netboot for rackpi5]]), `spore` (NFS/PXE server)
		- `spore` also runs the loopback-only Spore application and a root-only signed native-artifact publisher. The x86 static PXE tree remains isolated, while diskless `rackpi5` intentionally uses the Spore native route as its sole boot path; see [[ADR/0013 Git and Nix own the Spore boot catalog]].
	- **Cloud**: `oldboy` (GCE)
- ## Deploying
	- Build without deploying:
	- ```bash
	  nix build .#nixosConfigurations.<hostname>.config.system.build.toplevel
	  ```
	- Build a Raspberry Pi SD image natively on ARM:
	- ```bash
	  nix build .#nixosConfigurations.<hostname>.config.system.build.sdImage
	  ```
	- Deploy immediately:
	- ```bash
	  nixos-rebuild switch --flake .#<hostname> --target-host <hostname> --sudo
	  ```
	- Deploy safely (activates on next reboot):
	- ```bash
	  nixos-rebuild boot --sudo --target-host <hostname> --flake .#<hostname>
	  ```
	- Roll back on the host:
	- ```bash
	  sudo nixos-rebuild switch --rollback
	  ```
- ## Downloadable Pi images
	- Run the manual `nix-image-builder` workflow from GitHub Actions and select a Raspberry Pi image.
	- Pi images build on a native `ubuntu-24.04-arm` runner and are uploaded as `<image>-sd-image` artifacts.
	- Artifacts are retained for one day, so download them from the workflow run promptly.
- ## Auto-upgrades keep git honest
	- Hosts auto-rebuild from GitHub `main`. A config deployed from a branch **silently reverts** on the next upgrade cycle unless the branch merges promptly. Treat `nixos-rebuild` from a branch as a test, not a deploy.
- ## Disk layout
	- Partitioning is declarative via disko with GPT partlabels (`disk-main-*`). Hosts installed before the migration need their partitions relabeled or they fail to boot — see [[ADR/0004 Disko with GPT partlabels]] and the scripts in `nix/scripts/`.
- ## Dotfiles
	- mise-managed (`[dotfiles]` + `mise bootstrap --only dotfiles`) from the in-repo `dotfiles/` tree; an activation script applies them from the store path on every rebuild/boot, no network clone. See [[ADR/0011 Migrate dotfiles from chezmoi to mise]].
