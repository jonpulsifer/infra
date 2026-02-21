---
name: kubernetes-gitops
description: Work with Kubernetes manifests and GitOps workflows for the folly and offsite clusters. Covers FluxCD reconciliation, networking architecture, and SOPS secrets.
---

## Cluster Structure

```
k8s/clusters/
  folly/     # Primary on-site (nuc, optiplex, riptide, 800g2)
  offsite/   # Backup cluster (oldschool, retrofit)
```

Each cluster contains: `flux-system/`, `networking/`, `monitoring/`, `nodes/`, `storage/`, `sources/`.

## Making Changes

Changes to `k8s/` deploy automatically via FluxCD when merged to `main`.

```bash
# Check reconciliation status
flux get kustomizations -A
flux get helmreleases -A

# Force reconcile
flux reconcile kustomization <name> -n flux-system --with-source
```

## Networking Architecture

| Component     | Resource                                       | Purpose                          |
|---------------|------------------------------------------------|----------------------------------|
| CNI           | `networking/cilium/`                           | Pod networking + BGP LB          |
| Ingress       | `networking/gateway-api/cluster-gateway.yaml`  | Kubernetes Gateway API           |
| External      | `networking/cloudflare/cloudflared.yaml`        | Cloudflare Tunnel (no open ports)|
| Internal VPN  | `networking/tailscale/`                        | Tailscale operator               |
| TLS           | `networking/cert-manager/`                     | Let's Encrypt via Cloudflare DNS |
| DNS           | `networking/external-dns/`                     | Cloudflare records from Gateway  |

BGP IP pools are in `networking/cilium/ip-pools.yaml`.

## SOPS Secrets

Files matching `*.sops.yaml` are encrypted at rest. FluxCD decrypts via the cluster's age key.

```bash
# View/edit
sops k8s/clusters/folly/networking/tailscale/secret.sops.yaml

# Encrypt new file (must match path regex in .sops.yaml)
sops -e -i k8s/clusters/<cluster>/<path>.sops.yaml
```

Encrypted fields: `data` and `stringData` only (per `.sops.yaml`).

## Helm Releases

Apps use `HelmRelease` resources pointing to `HelmRepository` sources in `sources/helm/`. Renovate opens automatic update PRs for chart bumps.
