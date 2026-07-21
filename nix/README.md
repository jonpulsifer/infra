# NixOS Configuration

NixOS configurations for the homelab, managed as a Nix flake (`flake.nix` at the repo
root). The setup covers the Kubernetes node fleet, a collection of Raspberry Pis, a GCE
VM, and several installation images.

## 🏗️ Architecture

```
nix/
├── disko/             # Declarative disk layouts
├── hardware/          # Hardware-specific configurations (pi0, pi4, pi5, x86)
├── hosts/             # Per-host entry points (Pis, VMs)
├── images/            # Installer / image builders (iso, wsl, gce, container, netboot)
├── lib/               # mkHost / mkImage / apps helpers
├── overlays/          # Package overlays (mise, certmgr, runc, ddnsd, patches)
├── profiles/          # Reusable system profiles (k8s-node)
├── secrets/           # SOPS-encrypted per-host secrets
├── services/          # Optional service modules (k8s/, kiosk, nfs, netboot, …)
└── system/            # Core modules (users, ssh, tailscale, sops, dotfiles, …)
```

Hosts are declared in `flake.nix` as explicit `mkHost` calls (`nix/lib/mkHost.nix`), in
two styles:

- **Kubernetes nodes** are declared inline in the flake with `tags`/`role`/`imports`;
  `mkHost` wires in `profiles/k8s-node.nix` for them. There is no `nix/hosts/<name>.nix`
  for these.
- **Everything else** (Pis, oldboy) passes `modules = [ ./nix/hosts/<name>.nix ]`.

## 🖥️ Managed Systems

### Kubernetes clusters

**folly** (on-site): `optiplex` (control-plane), `riptide`, `shale`

**offsite**: `retrofit` (control-plane), `oldschool` (worker; docker + yarr)

### Raspberry Pis

- `cloudpi4`, `homepi4` – general service Pis
- `weatherpi4` – kiosk/display Pi (see the wiki runbook `Runbooks/Kiosk`)
- `dns` – lab DNS Pi
- `spore` – Pi 5: NFS server, PXE/netboot server, rackpi5 native-boot publisher
- `rackpi5` – Pi 5, netbooted; config in `nix/hosts/rackpi5.nix`
- `radiopi0`, `blinkypi0` – Pi Zero W (armv6l, cross-compiled; blinkypi0 mirrors radiopi0)

### Other

- `oldboy` – GCE VM

### Installation images

- `iso` – x86_64 NixOS installation ISO
- `wsl` – Windows Subsystem for Linux tarball
- `gce` – Google Compute Engine image
- `container` – system tarball
- `netboot` – PXE ramdisk/kernel/iPXE script bundle (served by spore)

## 🚀 Quick Start

### Development environment

```bash
nix develop
```

### Building systems

```bash
# Build a host system (does not deploy)
nix build .#nixosConfigurations.optiplex.config.system.build.toplevel

# Build installation media
nix build .#iso         # x86_64 NixOS ISO
nix build .#wsl         # WSL tarball builder
nix build .#gce         # Google Compute Engine image

# Build Raspberry Pi SD images (cross-compiled from an x86_64 build host)
nix build .#cloudpi4

# Build natively on an ARM host
nix build .#nixosConfigurations.cloudpi4.config.system.build.sdImage
```

The `nix-image-builder` GitHub Actions workflow builds Raspberry Pi images on native
`ubuntu-24.04-arm` runners. Run it manually from the Actions tab, choose an image, and
download the resulting `<image>-sd-image` artifact (kept for one day).

### Deploying updates

```bash
# On the target system (immediate activation)
sudo nixos-rebuild switch --flake .#<hostname>

# Build remotely and copy (immediate activation)
nixos-rebuild switch --flake .#<hostname> --target-host <hostname> --sudo

# Safer: prepare for next reboot instead of activating now
nixos-rebuild boot --sudo --target-host <hostname> --flake .#<hostname>
```

Prefer `boot` for remote or hard-to-reach systems — the new configuration is only
activated on the next reboot, so a bad change can't take the host down mid-deploy and
rollback is a reboot away.

## 🔧 Services

Custom service modules in `services/`:

- **`k8s/`** – NixOS service helpers for Kubernetes (Cilium CNI, Longhorn storage,
  gVisor runtime) — not the cluster manifests, which live in `clusters/`. Reads cluster
  network facts from the `clusters/<site>/config/cluster-topology.json` SSOT.
- **`common.nix`** – base server configuration (SSH, Tailscale, monitoring); imported by
  most hosts
- **`iperf3.nix`** – iperf3 server for netbench
- **`kiosk.nix`** – kiosk-mode display (see wiki `Runbooks/Kiosk`)
- **`nfs-server.nix`** – NFS exports (spore)
- **`ntp-server.nix`** – redundant Chrony LAN time servers (dns + spore)
- **`pxe-netboot.nix`** – dnsmasq/nginx PXE netboot server (spore)
- **`spore-native-boot.nix`** – signed Pi native-boot publisher (spore → rackpi5)
- **`yarr.nix`** – RSS reader (oldschool)

## 🌐 System Modules

Core modules in `system/`:

- **`nixos.nix`** – base NixOS settings (flakes, caching, auto-upgrade)
- **`user.nix`** – user account management
- **`ssh.nix`** – SSH server hardening
- **`tailscale.nix`** / **`tailscale-disable.nix`** – Tailscale VPN on/off
- **`sops.nix`** – sops-nix secrets wiring
- **`ddnsd.nix`** – dynamic DNS daemon (first-party, from `apps/ddnsd`)
- **`mise-dotfiles.nix`** – applies the in-repo `dotfiles/` via mise on activation
- **`quiker.nix`** – quicker boot/less quirky kernel settings

## 🔑 Inputs & Dependencies

Flake inputs (see `flake.nix`):

- **`nixpkgs`** – NixOS 26.05 package set (plus **`unstable`** for cherry-picks)
- **`nixos-hardware`**, **`nixos-raspberrypi`** – hardware support
- **`nixos-wsl`** – WSL integration
- **`disko`** – declarative disk partitioning
- **`sops-nix`** – SOPS secrets in NixOS
- **`hosts`** – StevenBlack's unified hosts file
- **`keys`** / **`rowbuttkeys`** / **`wannabekeys`** – SSH public keys fetched from GitHub

There is no home-manager and no dotfiles flake input — dotfiles ship via
`nix/system/mise-dotfiles.nix` from the in-repo `dotfiles/` tree.

## 🛠️ Common Tasks

### Adding a new host

For a Pi/VM-style host:

1. Create `hosts/<hostname>.nix` importing the right hardware module and
   `../services/common.nix`.
2. Add an `mkHost` call in `flake.nix`'s `nixosConfigurations`
   (`modules = [ ./nix/hosts/<hostname>.nix ];`) and, if it should be deployable via the
   flake apps, add it to `deployHosts`.

For a Kubernetes node: add an inline `mkHost` call with `tags` (`folly`/`offsite`),
optional `role = "control-plane"`, and `extraConfig.homelab.disko.device` — mirror an
existing node like `riptide`.

### Creating a new service

1. Create `services/<service>.nix` with an `options.services.<service>.enable` toggle.
2. Import it from the host config and set `services.<service>.enable = true;`.

### Updating dependencies

```bash
nix flake update                          # all inputs
nix flake lock --update-input nixpkgs     # one input
```

## 🔍 Troubleshooting

### Build failures

```bash
nix flake check
nix build --verbose .#nixosConfigurations.<host>.config.system.build.toplevel
```

### Disk space

```bash
nix-collect-garbage -d
sudo nix-collect-garbage -d && sudo /run/current-system/bin/switch-to-configuration boot
```

### WSL VHD optimization

After cleaning up space inside WSL, compact the VHD from Windows PowerShell (as
Administrator):

```powershell
Optimize-VHD ((Get-ChildItem -Path HKCU:\Software\Microsoft\Windows\CurrentVersion\Lxss | Where-Object { $_.GetValue("DistributionName") -eq 'nixos' }).GetValue("BasePath") + "\ext4.vhdx")
```

### Rolling back

```bash
sudo nix-env --list-generations --profile /nix/var/nix/profiles/system
sudo nixos-rebuild switch --rollback
```

## 📚 Resources

- [NixOS Manual](https://nixos.org/manual/nixos/stable/)
- [Nix Flakes](https://nixos.wiki/wiki/Flakes)
- [NixOS Search](https://search.nixos.org/)

## 🤝 Contributing

1. Test with `nix flake check`
2. Format with `nix fmt`
3. Build affected systems to verify
4. Document new options or services
