# 🏠 Homelab Infrastructure

Infrastructure-as-code for a multi-cloud homelab environment. This repository manages everything from bare metal NixOS hosts to Kubernetes clusters, cloud resources, and network configuration.

## 🗺️ Repository Overview

```
.
├── nix/           # NixOS configurations for bare metal hosts
├── clusters/      # Kubernetes GitOps manifests (folly, offsite, base) — FluxCD
├── terraform/     # All Terraform: gcp, cloudflare, tailscale, argo, vault,
│                  #   unifi, google-workspace, k8s (Flux bootstrap), modules/
├── apps/          # Deployable first-party services (agent-web, hermes, tidbyt, …)
├── packages/      # Shared building blocks (agent-web-ui, charts/)
├── images/        # Base & tool OCI images + cloudlab-linux VM build tooling
└── dotfiles/      # chezmoi-managed dotfiles
```

## 🚀 Quick Start

### Development Environment

This repository uses `mise` for portable repo tooling and Nix flakes for NixOS-specific workflows:

```bash
# Install portable tools
mise install

# Optional: enter the full Nix development shell
nix develop
```

**Preferred task runner: `mise`**

```bash
# Format all (Nix + Terraform)
mise run fmt

# Nix only
mise run nix:fmt

# Terraform only
mise run tf:fmt
```

### NixOS Systems

```bash
# Build a NixOS configuration
nix build .#nixosConfigurations.<hostname>.config.system.build.toplevel

# Build installation media
nix build .#iso         # x86_64 NixOS ISO
nix build .#wsl         # WSL tarball
nix build .#cloudpi4    # Raspberry Pi 4 SD image
```

See [`nix/README.md`](./nix/README.md) for detailed NixOS documentation.

### Terraform Infrastructure

```bash
cd terraform/gcp/projects/<project>
terraform init
terraform plan          # local inspection only — applies run through Atlantis on the PR
```

## 🏗️ Infrastructure Components

### NixOS Fleet

Declarative system configurations for:
- **Kubernetes clusters** - Two NixOS clusters (on-site + offsite)
- **Raspberry Pis** - Home automation, cloud services, kiosk displays
- **Installation images** - ISO, WSL, and cloud images

[→ Full NixOS documentation](./nix/README.md)

### Kubernetes

Multiple clusters running workloads:
- **Folly** - Primary on-site cluster (4 nodes: nuc, optiplex, riptide, 800g2)
- **Offsite** - Backup cluster (2 nodes: oldschool, retrofit)

Managed with:
- **ArgoCD** - GitOps continuous delivery
- **FluxCD** - Additional GitOps workflows
- **Cilium** - CNI and service mesh

### Cloud Resources

**Google Cloud Platform** (`terraform/gcp/`):
- Compute instances
- Cloud DNS
- IAM and service accounts
- Project configurations

**Cloudflare** (`terraform/cloudflare/`):
- DNS management
- Security policies
- Access controls

**Tailscale** (`terraform/tailscale/`):
- Tailnet policy, DNS, contacts, and settings
- Device authorization, key expiry, and tag state

## 🛠️ Technology Stack

- **Infrastructure as Code**: Terraform, NixOS
- **Orchestration**: Kubernetes (NixOS)
- **GitOps**: ArgoCD, FluxCD
- **Secrets**: SOPS, HashiCorp Vault
- **Networking**: Cilium, Tailscale, UniFi
- **Monitoring**: Prometheus, Grafana, Loki
- **CI/CD**: GitHub Actions (self-hosted)

## 📁 Directory Structure

### `nix/` - NixOS Configuration
Flake-based NixOS configurations for all physical and virtual machines. Modular structure with reusable profiles, services, and system configurations.

### `clusters/` - Kubernetes Manifests
FluxCD GitOps manifests for the `folly` and `offsite` clusters, with shared resources in `clusters/base/`. The Flux bootstrap itself is Terraform (`terraform/k8s/`).

### `terraform/` - Cloud, Network & Bootstrap
All Terraform root modules: `gcp/` (resources by project), `cloudflare/` (DNS & security), `tailscale/`, `argo/` (ArgoCD apps), `vault/` (policies), `unifi/` (network controller), `google-workspace/`, and `k8s/` (Flux bootstrap). Reusable modules live in `terraform/modules/`.

### `apps/`, `packages/`, `images/` - Code & Builds
First-party services (`apps/`), shared libraries and Helm charts (`packages/`), and base/tool container + VM images (`images/`).

## 🔐 Security

- **Immutable infrastructure** - NixOS ensures declarative system state
- **Secrets management** - SOPS encryption + Vault
- **Network segmentation** - VLANs and firewall rules via UniFi
- **Zero-trust networking** - Tailscale mesh VPN
- **SSH hardening** - Key-based auth only, automated key rotation
- **Automatic updates** - Renovate bot for dependency updates

## 🎯 Design Philosophy

1. **Declarative** - Infrastructure defined in code, not clicks
2. **Reproducible** - Nix flakes ensure identical environments
3. **Automated** - GitOps workflows for continuous deployment
4. **Observable** - Comprehensive monitoring and logging
5. **Secure** - Defense in depth with multiple security layers
6. **Modular** - Reusable components across environments

## 📚 Getting Started Guides

### First-time Setup

1. **Install Nix with flakes enabled**:
   ```bash
   sh <(curl -L https://nixos.org/nix/install) --daemon
   ```

2. **Clone the repository**:
   ```bash
   git clone https://github.com/jonpulsifer/infra.git
   cd infra
   ```

3. **Enter development environment**:
   ```bash
   nix develop
   ```

### Common Workflows

**Deploy a new NixOS host**:
```bash
# Build the system
nix build .#nixosConfigurations.<hostname>.config.system.build.toplevel

# Deploy remotely
nixos-rebuild switch --flake .#<hostname> --target-host <hostname> --use-remote-sudo
```

**Update Kubernetes app**:
```bash
# Changes are automatically deployed via ArgoCD
git commit -am "Update app version"
git push
```

### Backup Strategy

- **NixOS configs** - Version controlled in this repo
- **Kubernetes state** - GitOps repo is source of truth
- **Persistent data** - Automated backups to NAS + cloud storage
- **Secrets** - Encrypted SOPS files in repo + Vault backups

**Built with**: NixOS 25.05 • Kubernetes • Terraform • ArgoCD • Love ❤️
