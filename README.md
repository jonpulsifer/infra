# 🏠 Homelab Infrastructure

Infrastructure-as-code for a multi-cloud homelab environment. This repository manages everything from bare metal NixOS hosts to Kubernetes clusters, cloud resources, and network configuration.

## 🗺️ Repository Overview

```
.
├── nix/           # NixOS configurations for bare metal hosts
├── k8s/           # Kubernetes manifests and configurations
├── gcp/           # Google Cloud Platform (Terraform)
├── cloudflare/    # Cloudflare DNS and security (Terraform)
├── argo/          # ArgoCD applications
├── vault/         # HashiCorp Vault configurations
├── unifi/         # UniFi network controller configs
└── workspace/     # Development workspace utilities
```

## 🚀 Quick Start

### Development Environment

This repository uses Nix flakes for a reproducible development environment:

```bash
# Enter development shell with all tools
nix develop

# Tools included: kubectl, helm, terraform, vault, sops, fluxcd, cilium-cli, gcloud
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
cd gcp/projects/<project>
terraform init
terraform plan
terraform apply
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

**Google Cloud Platform** (`gcp/`):
- Compute instances
- Cloud DNS
- IAM and service accounts
- Project configurations

**Cloudflare** (`cloudflare/`):
- DNS management
- Security policies
- Access controls

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

### `k8s/` - Kubernetes Manifests
Application deployments, services, and configurations for Kubernetes clusters.

### `gcp/` - Google Cloud
Terraform configurations for GCP resources organized by project.

### `cloudflare/` - DNS & CDN
Terraform-managed DNS records and Cloudflare security policies.

### `argo/` - GitOps Applications
ArgoCD application definitions for declarative Kubernetes deployments.

### `vault/` - Secrets Management
HashiCorp Vault policies and configurations.

### `unifi/` - Network Controller
UniFi network device configurations and settings.

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
