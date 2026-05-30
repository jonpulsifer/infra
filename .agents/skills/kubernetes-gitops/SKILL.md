---
name: kubernetes-gitops
description: Work with Kubernetes manifests and GitOps workflows for the folly and offsite clusters. Covers FluxCD reconciliation, networking architecture, and SOPS secrets.
---

## Cluster Structure

```
k8s/
  base/      # Shared resources referenced by both clusters
  folly/     # Primary on-site (nuc, optiplex, riptide, 800g2)
  offsite/   # Backup cluster (oldschool, retrofit)
```

Each cluster contains: `flux-system/`, `networking/`, `monitoring/`, `nodes/`, `storage/`.

`base/` holds shared helm-releases (cert-manager, tailscale, external-dns, vector) used by both clusters via kustomize directory references. Cluster-specific values use Flux `postBuild` substitution with variables like `${CLUSTER_NAME}` from each cluster's `cluster-settings` ConfigMap.

Both clusters share `sources/` (HelmRepository definitions) and `sandbox/` from folly's directories via Flux Kustomization path references. Offsite also shares `external-secrets-operator/` and `external-secrets/` from folly.

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
sops k8s/folly/networking/tailscale/secret.sops.yaml

# Encrypt new file (must match path regex in .sops.yaml)
sops -e -i k8s/<cluster>/<path>.sops.yaml
```

Encrypted fields: `data` and `stringData` only (per `.sops.yaml`).

## Atlantis / ArgoCD Cross-Cluster Auth

Atlantis (offsite) connects to ArgoCD (folly) to verify Terraform plans against live application state.

| Component | Location | Account |
|-----------|----------|---------|
| Atlantis HelmRelease | `k8s/offsite/apps/atlantis/helm-release.yaml` | Connects via `ARGOCD_AUTH_TOKEN` |
| Atlantis secret | `k8s/offsite/apps/atlantis/secret.sops.yaml` | Stores `argocd_token` |
| ArgoCD config | `k8s/folly/apps/argo/helm-release.yaml` | Defines `accounts.atlantis: apiKey` + RBAC |

**When the ArgoCD token expires**, `atlantis/plan` checks fail with signature errors (JWT signed with a rotated key). Symptoms:
- GitHub PR status: `atlantis/plan: argo/default` → FAILURE
- Atlantis logs show gRPC/auth errors against `argo.${SECRET_DOMAIN}:443`

### Rotating the Token

```bash
# 1. Port-forward to ArgoCD server
kubectl port-forward -n argo svc/argo-argocd-server 9090:80

# 2. Get admin password and login
ARGOCD_PASS=$(kubectl get secrets -n argo argocd-initial-admin-secret -o jsonpath="{.data.password}" | base64 -d)
TOKEN=$(curl -s -X POST "http://localhost:9090/api/v1/session" \
  -H "Content-Type: application/json" \
  -d "{\"username\":\"admin\",\"password\":\"$ARGOCD_PASS\"}" | jq -r '.token')

# 3. Generate new token for the atlantis account
RESULT=$(curl -s -X POST "http://localhost:9090/api/v1/account/atlantis/token" \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d "{}")
NEW_TOKEN=$(echo "$RESULT" | jq -r '.token')

# 4. Update SOPS secret (decrypt → edit → re-encrypt)
sops k8s/offsite/apps/atlantis/secret.sops.yaml
# Replace the argocd_token value with base64-encoded NEW_TOKEN
```

## Helm Releases

Apps use `HelmRelease` resources pointing to `HelmRepository` sources in `sources/helm/`. Renovate opens automatic update PRs for chart bumps.
