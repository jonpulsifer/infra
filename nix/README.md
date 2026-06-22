# NixOS Configuration

This directory contains NixOS configurations for a homelab infrastructure using Nix flakes. The setup manages multiple physical hosts, Kubernetes clusters, Raspberry Pis, and various installation images.

## 🏗️ Architecture

The configuration is organized into modular components:

```
nix/
├── hardware/          # Hardware-specific configurations
├── hosts/             # Per-host configurations
├── profiles/          # Reusable system profiles
├── services/          # Service modules (k8s, jellyfin, etc.)
├── system/            # Core system configurations
└── overlays/          # Package overlays
```

## 🖥️ Managed Systems

### Kubernetes Clusters

**Folly Cluster** (on-site):
- `optiplex` - control-plane
- `riptide` - worker

**Offsite Cluster**:
- `oldschool` - worker (github-runner, yarr, docker)
- `retrofit` - control-plane

### Raspberry Pi Systems

- `cloudpi4` - Cloud services Pi
- `homepi4` - Home automation Pi
- `weatherpi4` - Display/kiosk Pi

### Installation Images

- `iso` - x86_64 NixOS installation ISO
- `wsl` - Windows Subsystem for Linux tarball
- `gce` - Google Compute Engine image

## 🚀 Quick Start

### Development Environment

Enter the development shell with all required tools:

```bash
nix develop
```

This provides: `kubectl`, `helm`, `terraform`, `sops`, `fluxcd`, `cilium-cli`, and more.

### Building Systems

Build a specific system configuration:

```bash
# Build a host system
nix build .#nixosConfigurations.nuc.config.system.build.toplevel

# Build installation media
nix build .#iso         # x86_64 NixOS ISO
nix build .#wsl         # WSL tarball
nix build .#gce         # Google Compute Engine image

# Build Raspberry Pi images
nix build .#cloudpi4    # SD card image
```

### Deploying Updates

After making changes, rebuild and deploy:

```bash
# On the target system (immediate activation)
sudo nixos-rebuild switch --flake .#<hostname>

# Or build remotely and copy (immediate activation)
nixos-rebuild switch --flake .#<hostname> --target-host <hostname> --sudo
```

#### Remote Rebuilding with Boot

For safer deployments, especially on remote systems, use `boot` instead of `switch`. This prepares the configuration for the next reboot rather than immediately activating it:

```bash
# Build remotely and prepare for next boot (safer)
nixos-rebuild boot --sudo --target-host <hostname> --flake .#<hostname>

# Example: Deploy to oldboy VM via Tailscale
nixos-rebuild boot --sudo --target-host nixos.pirate-musical.ts.net --flake .#oldboy
```

**Why use remote rebuilding?**

- **Safety**: `boot` action lets you test the configuration on reboot rather than immediately applying changes
- **Remote systems**: Deploy to systems you can't physically access (cloud VMs, remote servers)
- **Testing**: Verify configurations work before committing to them
- **Rollback**: Easier to rollback if something goes wrong on next boot
- **Network efficiency**: Build locally and transfer only the closure, rather than building on resource-constrained remote systems

**Common systems to rebuild remotely:**

- **Cloud VMs** (e.g., `oldboy` on GCE) - Access via Tailscale or public IP
- **Offsite hosts** (e.g., `oldschool`, `retrofit`) - Remote Kubernetes nodes
- **Headless systems** - Systems without direct console access

## 📦 Profiles

Reusable configuration profiles in `profiles/`:

- **`k8s-node.nix`** - Shared x86 Kubernetes node base (hardware, k8s, ethtool offload)

## 🔧 Services

Custom service modules in `services/`:

- **`k8s/`** - NixOS service helpers for Kubernetes (Cilium CNI, Longhorn storage, gVisor runtime) — not the cluster manifests, which live in `clusters/`
- **`common.nix`** - Base server configuration with SSH, Tailscale, monitoring
- **`jellyfin.nix`** - Media server
- **`github-runner.nix`** - Self-hosted GitHub Actions runners
- **`kiosk.nix`** - Kiosk mode display
- **`nas.nix`** - Network attached storage
- **`nix-serve.nix`** - Binary cache server
- **`yarr.nix`** - RSS reader

## 🌐 System Modules

Core system configurations in `system/`:

- **`nixos.nix`** - Base NixOS settings (flakes, caching, auto-upgrade)
- **`user.nix`** - User account management
- **`ssh.nix`** - SSH server configuration
- **`tailscale.nix`** - Tailscale VPN setup
- **`ddnsd.nix`** - Dynamic DNS daemon
- **`fpc.nix`** - Custom FPC configuration

## 🔑 Inputs & Dependencies

The flake uses several external inputs:

- **`nixpkgs`** - NixOS 25.05 package set
- **`nixos-hardware`** - Hardware-specific configurations
- **`nixos-wsl`** - WSL integration
- **`home-manager`** - User environment management
- **`dotfiles`** - Personal dotfiles repository
- **`ddnsd`** - Custom dynamic DNS daemon
- **`hosts`** - StevenBlack's unified hosts file

SSH keys are automatically imported from GitHub:
- `jonpulsifer.keys` - Main user keys
- `wannabehero.keys` - Additional authorized keys

## 🛠️ Common Tasks

### Adding a New Host

1. Create a new file in `hosts/<hostname>.nix`:

```nix
{ name, ... }:
{
  imports = [
    ../profiles/k8s-node.nix # for k8s nodes; otherwise ../hardware/x86 ../services/common.nix
  ];

  networking.hostName = name;
  # Add host-specific configuration
}
```

2. Add to `flake.nix` `baseHostsSpec` with metadata only (tags, system, or profile):

```nix
baseHostsSpec = {
  # ... existing hosts
  newhostname = { tags = [ "folly" ]; };
};
```

### Creating a New Service

1. Create `services/<service>.nix`:

```nix
{ config, lib, pkgs, ... }:
{
  options.services.<service> = {
    enable = lib.mkEnableOption "<service>";
  };

  config = lib.mkIf config.services.<service>.enable {
    # Service configuration
  };
}
```

2. Import in host configuration:

```nix
imports = [ ../services/<service>.nix ];
services.<service>.enable = true;
```

### Updating Dependencies

Update flake inputs:

```bash
# Update all inputs
nix flake update

# Update specific input
nix flake lock --update-input nixpkgs
```

## 🎯 Design Principles

1. **Declarative** - All system state defined in configuration
2. **Modular** - Reusable components shared across hosts
3. **Reproducible** - Flake lock ensures consistent builds
4. **Secure** - Immutable users, automatic security updates
5. **Observable** - Prometheus exporters on all nodes

## 📝 Configuration Features

- **Automatic garbage collection** - Weekly cleanup of old generations
- **Binary caching** - Custom cachix cache for faster builds
- **Tailscale integration** - Secure mesh networking
- **SSH hardening** - Key-based auth, fail2ban protection
- **Monitoring** - Node exporters for Prometheus
- **Dynamic DNS** - Automatic DNS updates via ddnsd

## 🔍 Troubleshooting

### Build failures

```bash
# Check flake evaluation
nix flake check

# Build with verbose output
nix build --verbose .#nixosConfigurations.<host>.config.system.build.toplevel
```

### Disk space issues

```bash
# Manual garbage collection
nix-collect-garbage -d

# Remove old boot entries
sudo nix-collect-garbage -d
sudo /run/current-system/bin/switch-to-configuration boot
```

### WSL VHD optimization

The WSL virtual hard disk can grow large over time. After cleaning up space in WSL, compact the VHD from Windows PowerShell (run as Administrator):

```powershell
# Optimize/compact the NixOS WSL VHD
Optimize-VHD ((Get-ChildItem -Path HKCU:\Software\Microsoft\Windows\CurrentVersion\Lxss | Where-Object { $_.GetValue("DistributionName") -eq 'nixos' }).GetValue("BasePath") + "\ext4.vhdx")
```

This recovers disk space after running garbage collection inside WSL.

### Rolling back

```bash
# List generations
sudo nix-env --list-generations --profile /nix/var/nix/profiles/system

# Rollback to previous generation
sudo nixos-rebuild switch --rollback
```

## 📚 Resources

- [NixOS Manual](https://nixos.org/manual/nixos/stable/)
- [Nix Flakes](https://nixos.wiki/wiki/Flakes)
- [NixOS Search](https://search.nixos.org/)
- [Home Manager Manual](https://nix-community.github.io/home-manager/)

## 🤝 Contributing

When making changes:

1. Test locally with `nix flake check`
2. Format code with `nix fmt`
3. Build affected systems to verify
4. Document any new options or services

